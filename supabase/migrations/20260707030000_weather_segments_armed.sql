-- Weather segments v2: conditional (armed) predictions + merchant location.
--
-- 'armed'   — merchant approved the prediction (or the sensitivity dial is at
--   100 = all-auto); the daily cron executes it unattended once the fresh
--   forecast still shows the favorability gap ("the weather deems true").
-- 'expired' — the forecast window (expires_on) passed without the trigger
--   verifying; terminal, a fresh prediction comes from a later cron run.
-- expires_on — suggested_on + the 3-day forecast horizon.
alter table public.weather_suggestion
  drop constraint if exists weather_suggestion_status_check;
alter table public.weather_suggestion
  add constraint weather_suggestion_status_check
  check (status in ('pending','armed','applying','applied','dismissed','failed','expired'));

alter table public.weather_suggestion
  add column if not exists expires_on date not null default (now()::date + 3);

create index if not exists weather_suggestion_shop_armed_idx
  on public.weather_suggestion (shop_id)
  where status = 'armed';

-- Merchant home location (browser geolocation, or state-picker fallback mapped
-- to a region centroid). Refines the home region's forecast query point; null
-- = never asked or denied.
alter table public.guardrail_config
  add column if not exists merchant_lat double precision,
  add column if not exists merchant_lon double precision;
