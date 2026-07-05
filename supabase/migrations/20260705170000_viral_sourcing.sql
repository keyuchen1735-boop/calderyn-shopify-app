-- Viral product sourcing (#17 discovery). GLOBAL platform reference data
-- (source_product/supplier/signal/score) is written ONLY by the cron.sourcing
-- ingest and read-only to merchants (no merchant-facing write route exists).
-- Tenant-specific data lives in the shop-scoped sourced_product_link.
-- Follows the warehouse convention: service-role access + manual .eq('shop_id'),
-- no RLS (RLS hardening is the separate #12 fast-follow).

create table if not exists supplier (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_supplier_id text not null,
  name text not null,
  reliability_score numeric,               -- 0..1 if the provider exposes it, else null
  created_at timestamptz not null default now(),
  unique (provider, external_supplier_id)
);

create table if not exists source_product (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_id text not null,
  title text not null,
  category text,
  image_urls text[] not null default '{}',
  unit_cost_cents integer not null,
  moq integer not null default 1,
  lead_time_days integer not null default 0,
  supplier_id uuid references supplier(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (provider, external_id)
);

create table if not exists source_product_signal (
  id bigserial primary key,
  source_product_id uuid not null references source_product(id) on delete cascade,
  kind text not null,                       -- 'order_volume_30d' | 'order_volume_7d' | 'trend_index' | ...
  value numeric not null,
  captured_at timestamptz not null default now()
);
create index if not exists source_product_signal_product_idx on source_product_signal (source_product_id);

create table if not exists source_product_score (
  source_product_id uuid primary key references source_product(id) on delete cascade,
  score numeric not null,                   -- 0..100
  phase text not null,                      -- 'external' | 'blended'
  decay numeric not null,                   -- 0..1 saturation multiplier
  computed_at timestamptz not null default now()
);
create index if not exists source_product_score_rank_idx on source_product_score (score desc);

-- Tenant-specific: which owned product a shop created from which viral source.
create table if not exists sourced_product_link (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  product_id uuid not null,                 -- -> product_dim.id (owned catalog)
  source_product_id uuid references source_product(id) on delete set null,
  supplier_id uuid references supplier(id) on delete set null,
  picked_at timestamptz not null default now(),
  unique (shop_id, product_id)
);
create index if not exists sourced_product_link_shop_idx on sourced_product_link (shop_id);

-- Append-only audit of each ingest run (rule 12: a degraded run is visible).
create table if not exists sourcing_run (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  fetched integer not null default 0,
  scored integer not null default 0,
  phase text not null default 'external',
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
