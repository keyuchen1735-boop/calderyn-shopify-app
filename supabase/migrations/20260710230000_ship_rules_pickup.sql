-- Shipping deferred D1 (2026-07-10 design): local pickup.
-- ship_rules.pickup_enabled turns on a free "Pick up — <origin city>" option at checkout
-- (fulfilled from shop_origin, one location v1). pickup_note is optional merchant copy
-- shown to buyers under the pickup option (hours, entrance, etc.).
alter table public.ship_rules
  add column if not exists pickup_enabled boolean not null default false;
alter table public.ship_rules
  add column if not exists pickup_note text
    check (pickup_note is null or char_length(pickup_note) <= 200);
