-- Restore weather_suggestion, dropped by an unchecked-in migration
-- (20260707185335_drop_weather_suggestion) while deployed main still reads it
-- via loadWeatherSuggestions (customers API 500, PGRST205). Recreates the
-- table to the exact shape of the checked-in migrations 20260706193000 +
-- 20260706200000 + 20260707030000 + 20260707180000. Row data is not
-- recoverable; the daily weather cron regenerates suggestions.
create table if not exists public.weather_suggestion (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null,
  suggested_on       date not null,
  source_region      text not null,
  dest_region        text not null,
  source_campaign_id uuid not null,
  dest_campaign_id   uuid not null,
  amount_cents       int  not null,
  source_score       numeric not null,
  dest_score         numeric not null,
  narrative          text not null,
  status             text not null default 'pending',
  created_at         timestamptz not null default now(),
  expires_on         date not null default (now()::date + 3),
  applied_at         timestamptz,
  unique (shop_id, suggested_on, source_campaign_id, dest_campaign_id)
);

alter table public.weather_suggestion
  drop constraint if exists weather_suggestion_status_check;
alter table public.weather_suggestion
  add constraint weather_suggestion_status_check
  check (status in ('pending','armed','applying','applied','dismissed','failed','expired'));

create index if not exists weather_suggestion_shop_pending_idx
  on public.weather_suggestion (shop_id, suggested_on)
  where status = 'pending';

create index if not exists weather_suggestion_shop_armed_idx
  on public.weather_suggestion (shop_id)
  where status = 'armed';

create index if not exists weather_suggestion_applied_idx
  on public.weather_suggestion (shop_id, applied_at desc)
  where status = 'applied';

alter table public.weather_suggestion enable row level security;

notify pgrst, 'reload schema';
