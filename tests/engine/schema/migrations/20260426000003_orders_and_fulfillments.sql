-- supabase/migrations/20260426000003_orders_and_fulfillments.sql
-- Plan 02 Task 5: order_fact, order_line_fact, fulfillment_fact with UTM + COGS snapshot.

create table public.order_fact (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references public.shops(id) on delete cascade,
  external_id       text not null,
  order_number      text not null,
  created_at_source timestamptz not null,
  total_cents       integer not null,
  subtotal_cents    integer not null,
  shipping_cents    integer not null default 0,
  tax_cents         integer not null default 0,
  discount_cents    integer not null default 0,
  currency          text not null default 'USD',
  financial_status  text,
  customer_country  text,
  customer_region   text,
  customer_city     text,
  referring_site    text,
  landing_site      text,
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,
  utm_content       text,
  utm_term          text,
  source_version    bigint not null,                                       -- Shopify order updated_at epoch ms
  created_at        timestamptz not null default now(),
  unique (shop_id, external_id)
);

create table public.order_line_fact (
  id                       uuid primary key default gen_random_uuid(),
  shop_id                  uuid not null references public.shops(id) on delete cascade,
  order_id                 uuid not null references public.order_fact(id) on delete cascade,
  sku_id                   uuid references public.sku_dim(id) on delete set null,
  external_line_id         text not null,
  quantity                 integer not null,
  price_cents              integer not null,
  total_cents              integer not null,
  unit_cost_cents_snapshot integer,                                        -- COGS at time of order, set by transformer
  unique (order_id, external_line_id)
);

create table public.fulfillment_fact (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops(id) on delete cascade,
  order_id        uuid not null references public.order_fact(id) on delete cascade,
  external_id     text not null,
  location_id     uuid references public.location_dim(id) on delete set null,
  status          text not null,                                           -- 'pending' | 'success' | 'cancelled' | 'error'
  carrier         text,
  shipped_at      timestamptz,
  delivered_at    timestamptz,
  source_version  bigint not null,
  unique (shop_id, external_id)
);

create index order_fact_created_idx on public.order_fact (shop_id, created_at_source desc);
create index order_line_sku_idx on public.order_line_fact (sku_id, order_id);
create index fulfillment_location_idx on public.fulfillment_fact (location_id, shipped_at desc);

alter table public.order_fact enable row level security;
alter table public.order_line_fact enable row level security;
alter table public.fulfillment_fact enable row level security;

create policy order_fact_read on public.order_fact
  for select using (shop_id = public.current_shop_id());

create policy order_line_read on public.order_line_fact
  for select using (shop_id = public.current_shop_id());

create policy fulfillment_read on public.fulfillment_fact
  for select using (shop_id = public.current_shop_id());
