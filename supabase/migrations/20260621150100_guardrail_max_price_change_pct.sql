-- Merchant-facing cap for the adjust_price action: the largest single-step
-- price change (whole percent) one click may apply to a variant. adjust_price
-- is confirm-only (never autopilot), so this is NOT an autopilot_* knob — it
-- bounds a human-approved write, the same way dollar_impact_cap bounds others.
-- Default 15% matches the suggested-price clamp. Idempotent.
alter table public.guardrail_config
  add column if not exists max_price_change_pct int not null default 15;
