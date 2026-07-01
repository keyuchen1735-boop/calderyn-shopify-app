-- import_map: durable mirror<->owned bridge (platform-pivot Step 9, #13.promote). Maps a
-- Shopify entity (shop_id, entity_type, external_id GID) to its owned row id. The webhook-dedup
-- key for the cutover phases (importing/dual_run) and the join key for the parity gate.
-- Service-role-only RLS (matches the owned intake/ledger tables + cutover_transition); the
-- INFO rls_enabled_no_policy advisor is expected and intentional.

create table if not exists public.import_map (
  id             uuid        primary key default gen_random_uuid(),
  shop_id        uuid        not null references public.shops(id) on delete cascade,
  entity_type    text        not null check (entity_type in ('product', 'variant', 'location')),
  external_id    text        not null,
  owned_id       uuid        not null,
  source_version bigint,
  promoted_at    timestamptz not null default now(),
  unique (shop_id, entity_type, external_id)
);

create index if not exists import_map_owned_idx
  on public.import_map(shop_id, entity_type, owned_id);

alter table public.import_map enable row level security;
revoke all on table public.import_map from anon, authenticated;

-- Extend promote_shop_catalog to record the product + variant bridge entries it promotes, in the
-- SAME one place the catalog promote already lives, so the map can never drift from the promote it
-- mirrors. Steps 1-4 are the existing body verbatim; step 5 is new. search_path stays '' so every
-- object is schema-qualified.
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
  --    Shopify external_id, idempotently. Locations are bridged by the one-time backfill below /
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
end $$;

-- One-time backfill: re-run promote for every shop (idempotent; now also records the product +
-- variant bridge for existing shops) and record the location bridge from the already-mirrored
-- location_dim rows.
select public.promote_shop_catalog(id) from public.shops;

insert into public.import_map (shop_id, entity_type, external_id, owned_id)
select l.shop_id, 'location', l.external_id, l.id
from public.location_dim l
where l.external_id is not null
on conflict (shop_id, entity_type, external_id) do nothing;
