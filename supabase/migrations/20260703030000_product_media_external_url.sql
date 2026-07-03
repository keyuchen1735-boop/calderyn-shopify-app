-- Mirror->product_media promote (platform-pivot Step 9, #13.promote; #16 rule-7 fix).
-- promote_shop_catalog() materialized product_dim/variant_dim/collections but NEVER
-- product_media, so imported products lost all imagery the moment the storefront read
-- the owned catalog at cutover. This migration:
--   1) captures the Shopify featured-image URL on the sku_dim mirror (sku_dim.image_url),
--   2) lets product_media hold an EXTERNAL (Shopify CDN) url distinct from a private-bucket
--      storage_path (the promote can't upload blobs; it hotlinks the mirror image), and
--   3) extends promote_shop_catalog to seed one product_media row per imported product.
-- Net-new uploaded/generated assets (#9) still land in storage_path; this owns only the
-- mirror->product_media promote write and never overrides an existing primary image.

-- 1) sku_dim gains the featured-image url (denormalized per variant, exactly like the
--    other product-level facets title/vendor/category). Idempotent so it composes with
--    the test-schema mirror. RLS unchanged — the new column inherits sku_dim's read policy.
alter table public.sku_dim add column if not exists image_url text;

-- 2) product_media: a promoted row references a Shopify-hosted image by url, so storage_path
--    (a private product-media bucket key, signed per request) becomes optional and a new
--    external_url column carries the hotlink. Exactly one source must be present so no row is
--    unresolvable. A partial unique key on (product_id, external_url) makes the promote's
--    upsert converge (re-promoting the same image is a no-op).
alter table public.product_media add column if not exists external_url text;
alter table public.product_media alter column storage_path drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'product_media_source_present'
  ) then
    alter table public.product_media
      add constraint product_media_source_present
      check (storage_path is not null or external_url is not null);
  end if;
end $$;

create unique index if not exists product_media_product_external_key
  on public.product_media(product_id, external_url) where external_url is not null;

-- 3) Recreate promote_shop_catalog with a new step 6 (product_media). Steps 1-5 are the
--    existing body verbatim (20260701140200); step 6 is new. search_path stays '' so every
--    object is schema-qualified. create-or-replace preserves the function's revoked grants.
create or replace function public.promote_shop_catalog(p_shop_id uuid) returns void
language plpgsql
set search_path = ''
as $$
begin
  -- 1) Products: one per distinct (shop_id, product_id GID). Product-level columns
  --    are denormalized identically across a product's sku_dim rows, so DISTINCT ON
  --    any row is correct. handle is a deterministic slug (unique per shop).
  insert into public.product_dim (shop_id, external_id, handle, title, status, vendor, category, tags, created_at, updated_at)
  select distinct on (s.shop_id, s.product_id)
    s.shop_id,
    s.product_id,
    'p-' || substr(md5(s.shop_id::text || ':' || s.product_id), 1, 16),
    s.title,
    case when s.product_status in ('draft','active','archived') then s.product_status else 'active' end,
    s.vendor,
    s.category,
    s.tags,
    s.created_at,
    s.updated_at
  from public.sku_dim s
  where s.shop_id = p_shop_id
  order by s.shop_id, s.product_id, s.created_at
  on conflict (shop_id, external_id) where (external_id is not null) do nothing;

  -- 2) Variants: one per sku_dim row, id PRESERVED.
  insert into public.variant_dim (id, shop_id, product_id, external_id, inventory_item_id, sku, title, price_tier, retail_price_cents, unit_cost_cents, currency, grams, inventory_policy, inventory_tracked, inventory_on_hand, created_at, updated_at)
  select
    s.id,
    s.shop_id,
    p.id,
    s.external_id,
    s.inventory_item_id,
    s.sku,
    s.title,
    s.price_tier,
    s.retail_price_cents,
    s.unit_cost_cents,
    s.currency,
    s.grams,
    s.inventory_policy,
    s.inventory_tracked,
    0,
    s.created_at,
    s.updated_at
  from public.sku_dim s
  join public.product_dim p on p.shop_id = s.shop_id and p.external_id = s.product_id
  where s.shop_id = p_shop_id
  on conflict (id) do nothing;

  -- 3) Collections from the text[] arrays (one collection_dim per distinct name per shop).
  insert into public.collection_dim (shop_id, handle, title)
  select distinct
    s.shop_id,
    substr(regexp_replace(lower(c.name), '[^a-z0-9]+', '-', 'g'), 1, 60),
    c.name
  from public.sku_dim s
  cross join lateral unnest(s.collections) as c(name)
  where s.shop_id = p_shop_id and c.name is not null and length(trim(c.name)) > 0
  on conflict (shop_id, handle) do nothing;

  -- 4) Link products to their collections. Join on the derived handle (not the
  -- title) so two display names that slugify to the same handle resolve to the
  -- one collection_dim row that step 3 kept, instead of dropping the loser's links.
  insert into public.product_collection (product_id, collection_id)
  select distinct p.id, col.id
  from public.sku_dim s
  join public.product_dim p on p.shop_id = s.shop_id and p.external_id = s.product_id
  cross join lateral unnest(s.collections) as c(name)
  join public.collection_dim col on col.shop_id = s.shop_id
    and col.handle = substr(regexp_replace(lower(c.name), '[^a-z0-9]+', '-', 'g'), 1, 60)
  where s.shop_id = p_shop_id and c.name is not null and length(trim(c.name)) > 0
  on conflict (product_id, collection_id) do nothing;

  -- 5) Record the mirror<->owned bridge for every promoted product + variant that carries a
  --    Shopify external_id, idempotently. Locations are bridged by the one-time backfill /
  --    recordImportMapEntry (this function does not promote locations).
  insert into public.import_map (shop_id, entity_type, external_id, owned_id)
  select p.shop_id, 'product', p.external_id, p.id
  from public.product_dim p
  where p.shop_id = p_shop_id and p.external_id is not null
  union all
  select v.shop_id, 'variant', v.external_id, v.id
  from public.variant_dim v
  where v.shop_id = p_shop_id and v.external_id is not null
  on conflict (shop_id, entity_type, external_id) do nothing;

  -- 6) Media: seed ONE product_media row per imported product that carries a Shopify
  --    featured-image url on its mirror. image_url is denormalized identically across a
  --    product's variants, so DISTINCT ON any row is correct. is_primary is set only when
  --    the product has no media yet, so a re-promote (or a #9 uploaded asset that already
  --    holds the primary slot) is never demoted. Idempotent: on conflict on the external
  --    url do nothing, so re-promoting the same image converges.
  insert into public.product_media (product_id, external_url, alt, position, is_primary)
  select distinct on (p.id)
    p.id,
    s.image_url,
    p.title,
    0,
    not exists (select 1 from public.product_media pm where pm.product_id = p.id)
  from public.sku_dim s
  join public.product_dim p on p.shop_id = s.shop_id and p.external_id = s.product_id
  where s.shop_id = p_shop_id
    and s.image_url is not null and length(trim(s.image_url)) > 0
  order by p.id, s.created_at
  on conflict (product_id, external_url) where (external_url is not null) do nothing;
end $$;
