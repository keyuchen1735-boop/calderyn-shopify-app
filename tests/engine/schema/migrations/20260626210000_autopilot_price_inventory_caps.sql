-- Bounded-magnitude autonomy for high-stakes autopilot actions (design 2026-06-26 §2.4).
-- Separate from guardrail_config.max_price_change_pct (which bounds CONFIRM-ONLY human
-- clicks); these bound the AUTONOMOUS path. Conservative defaults: 10% max autonomous
-- price move, NULL = unlimited autonomous stock move (merchant opts a cap in).
alter table public.guardrail_config
  add column if not exists autopilot_max_price_change_pct numeric not null default 10,
  add column if not exists autopilot_max_inventory_units_per_move integer;
