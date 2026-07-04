-- Day anchor for the calibration headline (spec §9 I6).
--
-- The calibration recompute moves from nightly to hourly so the agent
-- "calibrates hour by hour". smooth() clamps ±5 per RUN, which at an hourly
-- cadence would permit ±120/day — violating I6's ±5-per-day bound. The anchor
-- records the display value at the first recompute of each UTC day; every
-- later run that day is clamped to anchor ±5. The merchant's own
-- approve/reject nudge stays exempt (their just-made action must visibly move
-- the needle).

alter table public.shops
  add column if not exists calibration_anchor_pct int4,
  add column if not exists calibration_anchor_date date;
