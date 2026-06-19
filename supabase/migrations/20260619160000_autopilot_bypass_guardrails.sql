-- Autopilot bypass mode. When true, the guardrail check (actions/guardrails.ts)
-- waives every safety/rate gate — daily action cap, min spend, per-action dollar
-- cap, cooldown, business hours, and the budget %-change limits/ceiling. Still
-- gated by autopilot_enabled (bypass is a sub-mode of an enabled autopilot, not
-- a second kill-switch). Default OFF — opt-in, like autopilot itself.
alter table public.guardrail_config
  add column if not exists autopilot_bypass_guardrails boolean not null default false;
