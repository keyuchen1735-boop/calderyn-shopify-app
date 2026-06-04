-- supabase/migrations/20260426000001_core_dim_tables.sql
-- Plan 02 Task 3: SKU dimension + SCD2 cost history.

create table public.sku_dim (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references public.shops(id) on delete cascade,
  external_id       text not null,                                          -- Shopify variant id
  product_id        text not null,
  inventory_item_id text,                                                   -- Shopify inventory_item_id; distinct from variant id, used by inventory_levels webhooks
  sku               text,
  title             text not null,
  category          text,
  price_tier        text,                                                   -- 'under_30' | '30_60' | '60_150' | '150_plus'
  unit_cost_cents   integer,                                                -- SCD2 latest snapshot; full trail in sku_cost_history
  currency          text not null default 'USD',
  tags              text[] not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (shop_id, external_id)
);

create table public.sku_cost_history (
  id              bigserial primary key,
  sku_id          uuid not null references public.sku_dim(id) on delete cascade,
  unit_cost_cents integer not null,
  effective_from  timestamptz not null default now(),
  effective_to    timestamptz,
  source          text not null                                           -- 'shopify' | 'quickbooks' | 'manual_csv'
);

create index sku_dim_shop_idx on public.sku_dim (shop_id);
create index sku_dim_category_idx on public.sku_dim (shop_id, category, price_tier);
create index sku_dim_inventory_item_idx on public.sku_dim (shop_id, inventory_item_id) where inventory_item_id is not null;
create index sku_cost_history_sku_idx on public.sku_cost_history (sku_id, effective_from desc);

alter table public.sku_dim enable row level security;
alter table public.sku_cost_history enable row level security;

create policy sku_dim_read on public.sku_dim
  for select using (shop_id = public.current_shop_id());

create policy sku_cost_history_read on public.sku_cost_history
  for select using (
    exists (
      select 1 from public.sku_dim s
      where s.id = sku_cost_history.sku_id
        and s.shop_id = public.current_shop_id()
    )
  );

-- Writes happen under service_role (workers); RLS denies anon/authenticated INSERT/UPDATE/DELETE by default.
