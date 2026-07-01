-- Owned inventory (Slice 2): decrementable balance + journal + holds + transfers.
-- Stock tracked per (variant, location) with Shopify-style states; the owned
-- balance is the new authority, projected into inventory_level_fact so the
-- existing engine keeps reading the owned numbers. Keyed by internal shop_id;
-- new tables get RLS enabled with no policies (service-role only).

alter table public.location_dim alter column external_id drop not null;
alter table public.location_dim add column if not exists priority int not null default 0;
alter table public.location_dim add column if not exists lat double precision;
alter table public.location_dim add column if not exists lng double precision;

create table if not exists public.inventory_balance (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  variant_id uuid not null references public.variant_dim(id) on delete cascade,
  location_id uuid not null references public.location_dim(id) on delete cascade,
  on_hand int not null default 0,
  reserved int not null default 0,
  incoming int not null default 0,
  unavailable int not null default 0,
  available int generated always as (on_hand - reserved - unavailable) stored,
  reorder_point int,
  version bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique (variant_id, location_id)
);
create index if not exists inventory_balance_shop_variant_idx on public.inventory_balance(shop_id, variant_id);
alter table public.inventory_balance enable row level security;

create table if not exists public.inventory_ledger (
  id bigserial primary key,
  shop_id uuid not null references public.shops(id) on delete cascade,
  variant_id uuid not null,
  location_id uuid not null,
  entry_type text not null check (entry_type in ('receive','adjust','transfer_out','transfer_in','in_transit','received','reserve','release','sale','mark_unavailable')),
  qty int not null,
  reservation_id uuid,
  transfer_id uuid,
  order_ref text,
  idempotency_key text not null,
  reason text,
  source text not null default 'merchant',
  created_at timestamptz not null default now(),
  unique (shop_id, idempotency_key)
);
create index if not exists inventory_ledger_shop_variant_idx on public.inventory_ledger(shop_id, variant_id, created_at desc);
alter table public.inventory_ledger enable row level security;

create table if not exists public.inventory_reservation (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  variant_id uuid not null,
  location_id uuid not null,
  qty int not null,
  state text not null check (state in ('held','committed','released','expired')),
  checkout_ref text not null,
  expires_at timestamptz not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists inventory_reservation_checkout_idx on public.inventory_reservation(shop_id, checkout_ref);
create index if not exists inventory_reservation_expiry_idx on public.inventory_reservation(state, expires_at);
alter table public.inventory_reservation enable row level security;

create table if not exists public.inventory_transfer (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  variant_id uuid not null,
  from_location_id uuid not null,
  to_location_id uuid not null,
  qty int not null,
  state text not null check (state in ('in_transit','received','cancelled')),
  created_at timestamptz not null default now(),
  received_at timestamptz
);
alter table public.inventory_transfer enable row level security;
