-- Widen the autopilot candidate allow-list for Task 18b (outcome-gated autonomy
-- Phase 2): add the seven price/inventory detector IDs that now have graduated
-- executors (adjust_price → margin_erosion/cogs_drift; reallocate_inventory →
-- sku_stockout_vs_spend/regional_shortage_risk/regional_spend_starved_stock/
-- scaling_sku_fulfillment_risk/wrong_location_concentration).
-- The rest of the view body is verbatim from
-- 20260620121500_autopilot_candidates_remediation.sql — only the detector_id IN
-- list changes.
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
    'campaign_scaling_opportunity',
    'margin_erosion',
    'cogs_drift',
    'sku_stockout_vs_spend',
    'regional_shortage_risk',
    'regional_spend_starved_stock',
    'scaling_sku_fulfillment_risk',
    'wrong_location_concentration'
  );
