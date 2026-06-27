-- Per-feature autopilot on-switch. Graduation only UNLOCKS a (detector, action)
-- pair; it acts autonomously only after the merchant explicitly enables it here.
-- Defaults false so nothing fires on day one and existing rows reset to opt-in.
alter table public.pair_calibration
  add column if not exists autonomy_enabled boolean not null default false;
