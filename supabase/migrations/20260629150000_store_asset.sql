-- supabase/migrations/20260629150000_store_asset.sql
-- Imagery seam (#16 Phase C / #9): generated listing images keyed by (shop_id, product_id,
-- source). The catalog read path overrides a product's image with the latest 'ready' asset.
-- RLS modeled on buyer_identity; service-role only.
create table public.store_asset (
  shop_id    uuid not null references public.shops(id) on delete cascade,
  product_id text not null,
  source     text not null,
  url        text not null,
  status     text not null check (status in ('ready','failed')),
  created_at timestamptz not null default now(),
  primary key (shop_id, product_id, source)
);
create index store_asset_shop_idx on public.store_asset (shop_id);

alter table public.store_asset enable row level security;
create policy store_asset_shop_scope on public.store_asset
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.store_asset from anon, authenticated;
