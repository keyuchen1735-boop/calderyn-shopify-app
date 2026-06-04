-- supabase/migrations/20260426000004_ad_domain.sql
-- Plan 02 Task 6: ad domain — campaigns, creative_sku_map, spend, attribution.

create type public.ad_platform as enum ('meta', 'google');

create table public.ad_campaign_dim (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references public.shops(id) on delete cascade,
  platform           public.ad_platform not null,
  external_id        text not null,
  name               text not null,
  status             text not null,                                        -- 'active' | 'paused' | 'archived'
  objective          text,
  daily_budget_cents integer,
  currency           text not null default 'USD',
  geo_targets        text[] not null default '{}',
  created_at_source  timestamptz,
  last_synced_at     timestamptz not null default now(),
  unique (shop_id, platform, external_id)
);

create table public.ad_creative_sku_map (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  platform       public.ad_platform not null,
  creative_id    text not null,                                            -- Meta ad id or Google ad asset id
  creative_label text not null,                                            -- human-readable string for the UI
  sku_id         uuid references public.sku_dim(id) on delete set null,
  confidence     numeric(3,2) not null default 0.00,
  source         text not null,                                            -- 'engine_auto' | 'merchant_confirmed' | 'merchant_manual'
  confirmed_at   timestamptz,
  unique (shop_id, platform, creative_id, sku_id)
);

create table public.ad_spend_fact (
  id                   uuid primary key default gen_random_uuid(),
  shop_id              uuid not null references public.shops(id) on delete cascade,
  campaign_id          uuid not null references public.ad_campaign_dim(id) on delete cascade,
  day                  date not null,
  spend_cents          integer not null,
  impressions          integer not null default 0,
  clicks               integer not null default 0,
  conversions          integer not null default 0,
  revenue_attrib_cents integer not null default 0,
  polled_at            timestamptz not null default now(),
  unique (campaign_id, day)
);

create table public.attribution_fact (
  id                       uuid primary key default gen_random_uuid(),
  shop_id                  uuid not null references public.shops(id) on delete cascade,
  order_id                 uuid not null references public.order_fact(id) on delete cascade,
  campaign_id              uuid references public.ad_campaign_dim(id) on delete set null,
  platform                 public.ad_platform,
  attributed_revenue_cents integer not null default 0,
  attribution_method       text not null,                                  -- 'utm_exact' | 'referrer_host' | 'unknown'
  unique (order_id, campaign_id)
);

create index ad_campaign_shop_idx on public.ad_campaign_dim (shop_id, platform);
create index ad_spend_day_idx on public.ad_spend_fact (campaign_id, day desc);
create index ad_creative_label_idx on public.ad_creative_sku_map (shop_id, creative_label);

-- Partial unique indexes: Postgres treats NULL as distinct in UNIQUE, so we need
-- explicit partial indexes to prevent duplicate rows for the unmapped/unattributed states.
create unique index ad_creative_sku_map_unmapped_uq
  on public.ad_creative_sku_map (shop_id, platform, creative_id)
  where sku_id is null;

create unique index attribution_unattributed_uq
  on public.attribution_fact (order_id)
  where campaign_id is null;

alter table public.ad_campaign_dim enable row level security;
alter table public.ad_creative_sku_map enable row level security;
alter table public.ad_spend_fact enable row level security;
alter table public.attribution_fact enable row level security;

create policy ad_campaign_read on public.ad_campaign_dim
  for select using (shop_id = public.current_shop_id());

create policy ad_creative_read on public.ad_creative_sku_map
  for select using (shop_id = public.current_shop_id());

-- merchant_confirmed mappings come from the Settings UI under the authenticated session
create policy ad_creative_write on public.ad_creative_sku_map
  for all using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());

create policy ad_spend_read on public.ad_spend_fact
  for select using (shop_id = public.current_shop_id());

create policy attribution_read on public.attribution_fact
  for select using (shop_id = public.current_shop_id());
