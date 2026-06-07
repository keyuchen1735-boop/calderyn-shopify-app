-- Slice 4: auto-pilot. Opt-in toggle (also the kill-switch; default OFF) + the
-- autonomous-action bounds. Existing dollar_impact_cap_without_2fa and
-- cooldown_minutes_per_campaign are reused by the guardrail check.
alter table public.guardrail_config
  add column if not exists autopilot_enabled         boolean not null default false,
  add column if not exists autopilot_daily_action_cap int     not null default 3,
  add column if not exists autopilot_min_spend_cents   int     not null default 20000,
  add column if not exists autopilot_max_budget_cut_pct int    not null default 50;
