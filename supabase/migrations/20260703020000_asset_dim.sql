-- supabase/migrations/20260703020000_asset_dim.sql
-- Step 10 / #9 — owned asset storage + CDN.
--
-- Two net-new pieces, both separate from the existing PRIVATE 'product-media'
-- bucket (signed-URL, download-gated) and the 'social-digest' bucket:
--   1. A PUBLIC Storage bucket 'shop-assets'. Public objects get a stable,
--      CDN-fronted public URL for free from Supabase — that IS the CDN delivery
--      path. Writes are service-role only (getSupabase()); reads are public.
--   2. asset_dim — per-asset metadata (owning shop, kind, source, mime, bytes,
--      dimensions, storage key, public URL). RLS modeled on store_asset /
--      buyer_identity: shop-scoped policy via current_shop_id(), service-role
--      only. No PII ever lands here (asserted in app code by kind/allowlist).
--
-- Storage keys are shopId-scoped + uuid so public URLs are not enumerable.

insert into storage.buckets (id, name, public)
values ('shop-assets', 'shop-assets', true)
on conflict (id) do nothing;

create table public.asset_dim (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  storage_key text not null,
  public_url  text not null,
  kind        text not null,
  source      text not null check (source in ('upload','generated','mirrored')),
  mime        text not null,
  bytes       bigint not null,
  width       int,
  height      int,
  created_at  timestamptz not null default now(),
  unique (storage_key)
);
create index asset_dim_shop_idx on public.asset_dim (shop_id);

alter table public.asset_dim enable row level security;
create policy asset_dim_shop_scope on public.asset_dim
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.asset_dim from anon, authenticated;
