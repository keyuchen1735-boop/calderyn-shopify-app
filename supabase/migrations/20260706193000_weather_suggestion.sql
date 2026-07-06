-- Daily weather-driven reallocation suggestions, surfaced in the Customers →
-- Segments "Weather" panel for human approval. One row = one proposed move of
-- daily budget from a bad-weather-region campaign to a good-weather-region one.
-- Access is via the service role only (cron writer + approval route); RLS is
-- enabled with no policy so anon/authenticated roles are denied by default,
-- matching the other server-owned fact tables.
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
  status             text not null default 'pending'
                       check (status in ('pending','applied','dismissed')),
  created_at         timestamptz not null default now(),
  unique (shop_id, suggested_on, source_campaign_id, dest_campaign_id)
);

create index if not exists weather_suggestion_shop_pending_idx
  on public.weather_suggestion (shop_id, suggested_on)
  where status = 'pending';

alter table public.weather_suggestion enable row level security;
