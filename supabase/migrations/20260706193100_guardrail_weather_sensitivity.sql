-- Per-shop dial for the weather-reallocation feature: how aggressively to size a
-- suggested move, as a percent of the source campaign's daily budget scaled by
-- the weather score gap. 0 = feature OFF (default → zero regression; no
-- suggestions are written until a merchant opts in). This is NOT an autopilot_*
-- knob: weather suggestions are human-approved, so this bounds sizing only, it
-- does not feed the autopilot guardrail evaluator. Idempotent.
alter table public.guardrail_config
  add column if not exists weather_sensitivity int not null default 0;
