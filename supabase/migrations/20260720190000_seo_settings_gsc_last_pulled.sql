-- Cron fairness cursor for cron.seo-rankings (Radar Phase B hardening).
-- Ordering the nightly drain by gsc_last_pulled_at (nulls first) instead of
-- shop_id prevents tail-shop starvation once connected shops exceed the run's
-- time budget: skipped shops become the front of the next run.
alter table public.seo_settings add column if not exists gsc_last_pulled_at timestamptz;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'seo_settings'
      and column_name = 'gsc_last_pulled_at'
  ) then
    raise exception 'seo_settings.gsc_last_pulled_at was not added';
  end if;
end $$;
