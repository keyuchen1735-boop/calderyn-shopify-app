-- Owned catalog (Slice 1, Plan A): product/variant source of truth, options,
-- media, collections. sku_dim stays a real table; these are the new authority.

create table if not exists public.product_dim (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  external_id text,                       -- legacy Shopify product GID (promoted rows); null for owned
  handle text not null,
  title text not null,
  status text not null default 'draft' check (status in ('draft','active','archived')),
  vendor text,
  category text,
  description text,
  tags text[] not null default '{}',
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, handle)
);
create index if not exists product_dim_shop_updated_idx on public.product_dim(shop_id, updated_at desc);
create index if not exists product_dim_shop_status_idx on public.product_dim(shop_id, status);
create unique index if not exists product_dim_shop_external_key
  on public.product_dim(shop_id, external_id) where external_id is not null;
alter table public.product_dim enable row level security;

create table if not exists public.variant_dim (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  product_id uuid not null references public.product_dim(id) on delete cascade,
  external_id text,                       -- legacy Shopify variant GID; null for owned
  inventory_item_id text,
  sku text,
  title text not null default 'Default',
  price_tier text,
  retail_price_cents integer,
  unit_cost_cents integer,
  currency text not null default 'USD',
  grams integer,
  inventory_policy text,
  inventory_tracked boolean,
  inventory_on_hand integer not null default 0,
  requires_shipping boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists variant_dim_shop_id_idx on public.variant_dim(shop_id);
create index if not exists variant_dim_product_id_idx on public.variant_dim(product_id);
create unique index if not exists variant_dim_shop_external_key
  on public.variant_dim(shop_id, external_id) where external_id is not null;
alter table public.variant_dim enable row level security;

create table if not exists public.product_option (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.product_dim(id) on delete cascade,
  name text not null,
  position integer not null default 0
);
create table if not exists public.product_option_value (
  id uuid primary key default gen_random_uuid(),
  option_id uuid not null references public.product_option(id) on delete cascade,
  value text not null,
  position integer not null default 0
);
create table if not exists public.variant_option_value (
  variant_id uuid not null references public.variant_dim(id) on delete cascade,
  option_value_id uuid not null references public.product_option_value(id) on delete cascade,
  primary key (variant_id, option_value_id)
);
alter table public.product_option enable row level security;
alter table public.product_option_value enable row level security;
alter table public.variant_option_value enable row level security;

create table if not exists public.product_media (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.product_dim(id) on delete cascade,
  storage_path text not null,
  alt text,
  position integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists product_media_product_id_idx on public.product_media(product_id);
create index if not exists product_media_primary_idx on public.product_media(product_id) where is_primary;
alter table public.product_media enable row level security;

create table if not exists public.collection_dim (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  handle text not null,
  title text not null,
  description text,
  created_at timestamptz not null default now(),
  unique (shop_id, handle)
);
create table if not exists public.product_collection (
  product_id uuid not null references public.product_dim(id) on delete cascade,
  collection_id uuid not null references public.collection_dim(id) on delete cascade,
  primary key (product_id, collection_id)
);
alter table public.collection_dim enable row level security;
alter table public.product_collection enable row level security;
