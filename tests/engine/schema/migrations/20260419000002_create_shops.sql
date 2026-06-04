-- supabase/migrations/20260419000002_create_shops.sql
create table public.shops (
  id              uuid primary key default gen_random_uuid(),
  shop_domain     text not null unique,         -- e.g. 'calderyn-dev.myshopify.com'
  installed_at    timestamptz not null default now(),
  uninstalled_at  timestamptz,
  peer_data_consent boolean not null default false,
  super_admin_disabled boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.shops enable row level security;

create index shops_domain_idx on public.shops (shop_domain);
