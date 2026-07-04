-- Fix the daily_action_budget default to the spec value (I2: $2,500/day).
--
-- The column shipped with default 10 (dollars). Since the I2 aggregate
-- ceiling gates SUM(today's autonomous dollar impact) + this action's
-- impact, a $10/day ceiling silently blocks nearly every autonomous action
-- on any shop that never edited the setting — even fully graduated pairs.
-- The calibration spec (§9 I2) names $2,500/day as the default for this
-- exact guardrail.
--
-- Backfill only rows still at the untouched old default (exactly 10), so a
-- merchant who deliberately chose a value keeps it. Loosening here is a
-- product-default decision, not learning: the learning loop remains
-- tighten-only.

alter table public.guardrail_config
  alter column daily_action_budget set default 2500;

update public.guardrail_config
set daily_action_budget = 2500
where daily_action_budget = 10;
