-- Phase 4 (product-economics remediation): autopilot must act on the stored
-- RemediationPlan, which is computed from detector + dollar_impact + evidence,
-- targeting a SKU (discontinue_sku) or a campaign (reallocate_spend_sku / cut).
-- The prior view inner-joined ad_campaign_dim, so SKU-only economics alerts
-- (no entity_ref.campaign_id) were dropped and no evidence was carried. This
-- revision: (1) LEFT JOINs the campaign so SKU-only rows survive, (2) carries
-- evidence + sku + sku_id, (3) keeps the existing detector allow-list and the
-- campaign-spend column (now null-safe for SKU-only rows). security_invoker so
-- per-shop RLS still applies. Body otherwise mirrors 20260616132100.
create or replace view public.v_autopilot_candidates
with (security_invoker = true) as
select
  a.id            as alert_id,
  a.shop_id       as shop_id,
  a.detector_id   as detector_id,
  a.dollar_impact as dollar_impact,
  c.id            as campaign_id,
  coalesce(c.daily_budget_cents, 0) as daily_budget_cents,
  coalesce((
    select sum(s.spend_cents) from public.ad_spend_fact s
    where s.campaign_id = c.id and s.day >= (current_date - 7)
  ), 0) as campaign_spend_cents,
  -- New for remediation: the engine ranks from evidence; SKU moves target sku/sku_id.
  coalesce(ac.evidence, '{}'::jsonb) as evidence,
  coalesce(a.entity_ref ->> 'sku', sku.sku) as sku,
  a.entity_ref ->> 'sku_id' as sku_id
from public.alerts a
  left join public.ad_campaign_dim c on c.id = (a.entity_ref ->> 'campaign_id')::uuid
  left join public.alert_context ac  on ac.alert_id = a.id
  left join public.sku_dim sku       on sku.id::text = a.entity_ref ->> 'sku_id'
where a.status = 'open'
  and a.detector_id in (
    'campaign_below_breakeven',
    'negative_unit_economics',
    'ad_tax_overload',
    'campaign_scaling_opportunity'
  );
