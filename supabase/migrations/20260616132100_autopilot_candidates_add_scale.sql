-- F1 scale-up: surface campaign_scaling_opportunity alerts to autopilot. Same
-- body as 20260606150000; only the detector_id allow-list gains the new id.
-- security_invoker so per-shop RLS still applies.
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
  ), 0) as campaign_spend_cents
from public.alerts a
join public.ad_campaign_dim c on c.id = (a.entity_ref->>'campaign_id')::uuid
where a.status = 'open'
  and a.detector_id in (
    'campaign_below_breakeven',
    'negative_unit_economics',
    'ad_tax_overload',
    'campaign_scaling_opportunity'
  );
