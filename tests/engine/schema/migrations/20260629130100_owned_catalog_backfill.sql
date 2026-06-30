-- Backfill owned tables from the existing sku_dim mirror. The catalog+collections
-- promote logic lives in ONE place: promote_shop_catalog(p_shop_id) (scoped to a
-- single shop, idempotent via on-conflict guards). This migration calls it for
-- every existing shop; the Shopify-import feature reuses the SAME function (its
-- promote_shop_from_mirror does `perform public.promote_shop_catalog(p_shop_id)`
-- then seeds inventory) so the catalog inserts never drift across two code paths.
--
-- variant_dim.id is set to sku_dim.id so every order/refund/inventory reference to
-- the variant survives unchanged.

create or replace function public.promote_shop_catalog(p_shop_id uuid) returns void
language plpgsql
-- Pin an empty search_path so the function can't be hijacked via a mutable path;
-- every object below is schema-qualified and built-ins resolve via pg_catalog.
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
end $$;

-- One-time backfill: promote every existing shop's mirror into the owned tables.
select public.promote_shop_catalog(id) from public.shops;
