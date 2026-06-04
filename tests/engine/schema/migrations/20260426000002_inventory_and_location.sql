-- supabase/migrations/20260426000002_inventory_and_location.sql
-- Plan 02 Task 4: location_dim + inventory_level_fact (idempotent on source_version).

create table public.location_dim (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  external_id  text not null,                                         -- Shopify location id
  name         text not null,
  country      text,
  region       text,
  city         text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (shop_id, external_id)
);

create table public.inventory_level_fact (
  id             bigserial primary key,
  shop_id        uuid not null references public.shops(id) on delete cascade,
  sku_id         uuid not null references public.sku_dim(id) on delete cascade,
  location_id    uuid not null references public.location_dim(id) on delete cascade,
  available      integer not null,
  observed_at    timestamptz not null,
  source_version bigint not null,                                     -- Shopify inventory_level updated_at as epoch ms
  unique (sku_id, location_id, source_version)
);

create index location_dim_shop_idx on public.location_dim (shop_id);
create index inventory_level_current_idx on public.inventory_level_fact (sku_id, location_id, observed_at desc);

alter table public.location_dim enable row level security;
alter table public.inventory_level_fact enable row level security;

create policy location_dim_read on public.location_dim
  for select using (shop_id = public.current_shop_id());

create policy inventory_level_read on public.inventory_level_fact
  for select using (shop_id = public.current_shop_id());
