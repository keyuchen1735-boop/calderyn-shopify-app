-- Durable verification and generation-safe tombstones for immutable bundle assets.

create table public.storefront_asset_object (
  shop_id uuid not null references public.shops(id) on delete cascade,
  asset_key text not null,
  content_hash text not null check (content_hash ~ '^[A-Fa-f0-9]{64}$'),
  media_type text not null,
  byte_size bigint not null check (byte_size > 0),
  state text not null check (state in ('staged', 'verified', 'deleting', 'deleted', 'failed')),
  generation bigint not null default 1 check (generation > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, asset_key),
  unique (shop_id, content_hash, media_type)
);

create table public.storefront_bundle_asset (
  shop_id uuid not null references public.shops(id) on delete cascade,
  bundle_id uuid not null,
  asset_key text not null,
  status text not null check (status in ('verified', 'locked', 'failed')),
  created_at timestamptz not null default now(),
  primary key (shop_id, bundle_id, asset_key),
  foreign key (shop_id, bundle_id)
    references public.storefront_bundle_version (shop_id, id) on delete no action deferrable initially deferred,
  foreign key (shop_id, asset_key)
    references public.storefront_asset_object (shop_id, asset_key) on delete no action deferrable initially deferred
);

create index storefront_bundle_asset_object_idx
  on public.storefront_bundle_asset (shop_id, asset_key);

alter table public.storefront_asset_object enable row level security;
alter table public.storefront_bundle_asset enable row level security;

revoke all on table public.storefront_asset_object from anon, authenticated;
revoke all on table public.storefront_bundle_asset from anon, authenticated;
