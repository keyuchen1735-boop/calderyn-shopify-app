-- Ship-cost cron phase (Phase 4 of /cron/ingest) previously issued one PostgREST
-- round-trip per order per tick — ~11k serial order_fact updates plus thousands of
-- sku_pnl updates across the active shops — which alone exhausted the function's
-- 300s ceiling (the recurring 504) and starved every later phase. Two changes:
--
--  1. v_order_ship_features exposes the CURRENTLY-stored resolution columns so the
--     runner can diff in memory and skip rows whose resolution did not change
--     (steady-state ticks become read-only).
--  2. Set-based apply functions land all changed rows in one statement per batch
--     via jsonb_to_recordset, instead of one round-trip per row.

-- The new columns MUST be appended after the existing ones: CREATE OR REPLACE VIEW
-- only permits adding columns at the END of the column list (inserting mid-list
-- fails with 42P16 "cannot change name of view column"). NOTE the column order
-- below follows the view as DEPLOYED (ship_cost_manual_cents is LAST, position 7
-- — it was itself appended at the end when 20260616130500 shipped), not the
-- order the 20260616130500 file shows. Verified against prod information_schema
-- 2026-07-01; consumers select by name, so ordering is invisible to them.
create or replace view public.v_order_ship_features
with (security_invoker = true) as
select
  o.id,
  o.shop_id,
  o.customer_country,
  case
    when count(ol.id) = 0 then null
    when bool_or(ol.grams is null) then null
    else sum(ol.grams)::int
  end as grams_sum,
  coalesce(sum(ol.quantity), 0)::int as item_count,
  (select count(*) from public.fulfillment_fact f where f.order_id = o.id)::int as fulfillment_count,
  o.ship_cost_manual_cents,
  o.ship_cost_cents,
  o.ship_cost_source,
  o.ship_cost_confidence
from public.order_fact o
left join public.order_line_fact ol on ol.order_id = o.id
group by o.id, o.shop_id, o.customer_country, o.ship_cost_manual_cents,
         o.ship_cost_cents, o.ship_cost_source, o.ship_cost_confidence;

-- Apply a batch of resolved ship costs to order_fact in one statement. Every write
-- is fenced to p_shop_id: the caller is the service-role cron client which bypasses
-- RLS, so the shop filter is the only cross-tenant guard (same convention as the
-- TS runner's per-row writes it replaces). Returns the number of rows updated so
-- the caller can detect a batch that silently matched fewer rows than it sent.
create or replace function public.ship_cost_apply_order_updates(
  p_shop_id uuid, p_rows jsonb
) returns integer language plpgsql set search_path = '' as $$
declare v_count integer;
begin
  update public.order_fact o
     set ship_cost_cents = r.ship_cost_cents,
         ship_cost_source = r.ship_cost_source,
         ship_cost_confidence = r.ship_cost_confidence,
         ship_cost_reconciled_at = r.ship_cost_reconciled_at
    from jsonb_to_recordset(p_rows) as r(
      id uuid,
      ship_cost_cents integer,
      ship_cost_source text,
      ship_cost_confidence text,
      ship_cost_reconciled_at timestamptz)
   where o.id = r.id and o.shop_id = p_shop_id;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Same batching for the sku_pnl roll-in (ship cost + recomputed contribution margin).
create or replace function public.ship_cost_apply_sku_pnl_updates(
  p_shop_id uuid, p_rows jsonb
) returns integer language plpgsql set search_path = '' as $$
declare v_count integer;
begin
  update public.sku_pnl s
     set ship_cost_cents = r.ship_cost_cents,
         contribution_margin_cents = r.contribution_margin_cents
    from jsonb_to_recordset(p_rows) as r(
      id uuid,
      ship_cost_cents integer,
      contribution_margin_cents integer)
   where s.id = r.id and s.shop_id = p_shop_id;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Deny-by-default execute grants, mirroring 20260604150000_revoke_anon_rpc_execute:
-- these are service-role-only write paths; without the revoke, Postgres grants
-- EXECUTE to PUBLIC and PostgREST exposes them at /rest/v1/rpc to the anon key.
revoke all on function public.ship_cost_apply_order_updates(uuid, jsonb) from public;
revoke execute on function public.ship_cost_apply_order_updates(uuid, jsonb) from anon, authenticated;
revoke all on function public.ship_cost_apply_sku_pnl_updates(uuid, jsonb) from public;
revoke execute on function public.ship_cost_apply_sku_pnl_updates(uuid, jsonb) from anon, authenticated;
