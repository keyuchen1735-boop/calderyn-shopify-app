-- Add 'applying' and 'failed' to the weather_suggestion status set.
--   'applying' — the approval route atomically claims a row (pending → applying
--     via a conditional UPDATE) BEFORE moving any budget, so two concurrent
--     approvals cannot both call executeReallocation (no double-spend).
--   'failed'   — honest terminal state when executeReallocation returns a
--     permanent failure; the idempotency key is then consumed, so the row is not
--     left misleadingly 'pending'. A fresh suggestion comes from the next cron.
alter table public.weather_suggestion
  drop constraint if exists weather_suggestion_status_check;
alter table public.weather_suggestion
  add constraint weather_suggestion_status_check
  check (status in ('pending','applying','applied','dismissed','failed'));
