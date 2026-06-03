-- Ad-level dim + daily insight fact (incl engagement). Shared with #3.
create table if not exists public.ad_dim (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  external_id text not null,
  campaign_external_id text not null,
  adset_external_id text,
  name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, external_id)
);
create index if not exists ad_dim_shop_campaign_idx
  on public.ad_dim (shop_id, campaign_external_id);

create table if not exists public.ad_insight_fact (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ad_external_id text not null,
  campaign_external_id text not null,
  day_bucket date not null,
  spend_cents bigint not null default 0,
  impressions bigint not null default 0,
  link_clicks bigint not null default 0,
  purchases bigint not null default 0,
  purchase_value_cents bigint not null default 0,
  currency text not null default 'USD',
  reactions bigint not null default 0,
  comments bigint not null default 0,
  shares bigint not null default 0,
  saves bigint not null default 0,
  post_engagement bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique (shop_id, ad_external_id, day_bucket)
);
create index if not exists ad_insight_fact_shop_campaign_day_idx
  on public.ad_insight_fact (shop_id, campaign_external_id, day_bucket);
