-- Test-DB parity mirror of supabase/migrations/20260502000042_ad_engagement.sql.
-- The CI engine test DB is built from tests/engine/schema/migrations/*.sql; this
-- table was added to the Supabase schema during the analytics port but never
-- mirrored here, so DB-backed engine tests fail with "relation ... does not exist".

create table public.ad_engagement_fact (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops(id) on delete cascade,
  campaign_id     uuid not null references public.ad_campaign_dim(id) on delete cascade,
  ad_external_id  text not null,
  ad_name         text not null default '',
  day             date not null,
  impressions     integer not null default 0,
  link_clicks     integer not null default 0,
  reactions       integer not null default 0,
  comments        integer not null default 0,
  shares          integer not null default 0,
  saves           integer not null default 0,
  post_engagement integer not null default 0,
  polled_at       timestamptz not null default now(),
  unique (campaign_id, ad_external_id, day)
);

create index ad_engagement_shop_day_idx on public.ad_engagement_fact (shop_id, day desc);

alter table public.ad_engagement_fact enable row level security;

create policy ad_engagement_read on public.ad_engagement_fact
  for select using (shop_id = public.current_shop_id());
