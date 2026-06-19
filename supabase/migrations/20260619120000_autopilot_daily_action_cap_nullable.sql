-- Make autopilot_daily_action_cap nullable so "Unlimited" (no daily cap) can be
-- expressed as NULL, mirroring autopilot_max_daily_budget_cents (NULL = no
-- ceiling). The evaluator (app/lib/actions/guardrails.ts) treats a NULL cap as
-- "skip the daily-cap check entirely". Existing rows keep their integer value;
-- the column default (3) still applies to fresh inserts that omit it.
--
-- Idempotent: only drops NOT NULL when the column is still marked NOT NULL.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'guardrail_config'
      and column_name = 'autopilot_daily_action_cap'
      and is_nullable = 'NO'
  ) then
    alter table public.guardrail_config
      alter column autopilot_daily_action_cap drop not null;
  end if;
end $$;
