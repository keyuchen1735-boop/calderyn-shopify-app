-- F1 scale-up: per-shop caps for autopilot budget INCREASES (mirror of the
-- existing autopilot_max_budget_cut_pct). max_daily_budget_cents is nullable:
-- NULL means "no ceiling" so existing shops are not unexpectedly blocked.
alter table public.guardrail_config
  add column if not exists autopilot_max_budget_increase_pct int not null default 20,
  add column if not exists autopilot_max_daily_budget_cents   int;
