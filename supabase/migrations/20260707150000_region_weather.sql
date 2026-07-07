-- Precomputed current weather condition per coarse RegionCode bucket, refreshed
-- by cron.weather-merch. The public storefront reads this (one cheap indexed row)
-- to decide which products to float to the top, instead of calling Open-Meteo
-- inline on every buyer request (an 8s external fetch). Global, non-shop-scoped,
-- non-sensitive (aggregate temperature/precipitation only), so it carries a
-- read-for-all RLS policy — the storefront is a public surface. Writes are
-- service-role only (the cron), which bypasses RLS.
create table if not exists public.region_weather (
  region         text primary key,
  condition      text not null check (condition in ('sun', 'storm', 'neutral')),
  avg_temp_c     numeric,
  precip_mm      numeric,
  snow_cm        numeric,
  avg_daylight_h numeric,
  updated_at     timestamptz not null default now()
);

alter table public.region_weather enable row level security;

drop policy if exists region_weather_public_read on public.region_weather;
create policy region_weather_public_read
  on public.region_weather for select
  using (true);
