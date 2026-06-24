-- Ship Calderyn's three baseline no-brainer Autopilot features as unlocked.
-- They remain bounded by the shop-level Autopilot switch, per-feature switch,
-- live calibration rules, undo support, guardrails, freshness checks, and
-- detector-specific execution preconditions.

insert into public.pair_calibration as pc (
  shop_id,
  detector_id,
  action_kind,
  graduated,
  last_conf
)
select
  s.id,
  f.detector_id,
  'pause_campaign'::public.action_kind,
  true,
  74
from public.shops s
cross join (
  values
    ('sku_stockout_vs_spend'),
    ('campaign_below_breakeven'),
    ('negative_unit_economics')
) as f(detector_id)
on conflict (shop_id, detector_id, action_kind) do update
set
  graduated = (
    not pc.merchant_disabled
    and pc.consecutive_undos = 0
  ),
  last_conf = greatest(pc.last_conf, excluded.last_conf),
  updated_at = now();
