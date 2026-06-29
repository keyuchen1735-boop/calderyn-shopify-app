-- commerce_quote_fact: append-only LOCKED quotes. A re-presented quote_id is the SAME
-- quote (no re-price drift) — the "no second chance" guarantee for agentic surfaces.
--
-- Hardened-migration pattern (20260629100000_buyer_identity.sql): shop_id is uuid
-- referencing shops(id); RLS for all using current_shop_id(); anon/authenticated revoked.
-- Money is integer cents (matches orders / checkout_session).
--
-- SCHEMA ADJUSTMENT: plan specified `shop_id text` but the live schema uses uuid
-- throughout (sku_dim, order_fact, orders, buyer_dim all carry `uuid` shop_id
-- referencing shops(id)). Changed to `uuid not null references public.shops(id)`.
create table if not exists public.commerce_quote_fact (
  shop_id          uuid        not null references public.shops(id) on delete cascade,
  quote_id         uuid        not null default gen_random_uuid(),
  client_id        text,
  line_items       jsonb       not null,
  subtotal_cents   integer     not null,
  shipping_cents   integer     not null,
  tax_cents        integer     not null,
  total_cents      integer     not null,
  currency         text        not null,
  destination_hash text        not null,
  source_version   integer     not null default 1,
  low_confidence   boolean     not null default false,
  fallback_used    boolean     not null default false,
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now(),
  primary key (quote_id, source_version)
);
create index if not exists idx_commerce_quote_fact_shop
  on public.commerce_quote_fact (shop_id, created_at desc);

alter table public.commerce_quote_fact enable row level security;
create policy commerce_quote_fact_shop_scope on public.commerce_quote_fact
  for all
  using  (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.commerce_quote_fact from anon, authenticated;

-- shop_origin: merchant ship-from. Populated from Shopify shop.billingAddress on first
-- quote, or set by the merchant. Absent/incomplete => quoting fails visibly (ORIGIN_NOT_CONFIGURED).
--
-- SCHEMA ADJUSTMENT: plan specified `shop_id text primary key`; changed to
-- `uuid primary key references public.shops(id)` to match schema convention.
create table if not exists public.shop_origin (
  shop_id    uuid        primary key references public.shops(id) on delete cascade,
  name       text,
  street1    text        not null,
  street2    text,
  city       text        not null,
  state      text        not null,
  zip        text        not null,
  country    text        not null default 'US',
  source     text        not null default 'shopify', -- 'shopify' | 'merchant'
  updated_at timestamptz not null default now()
);

alter table public.shop_origin enable row level security;
create policy shop_origin_shop_scope on public.shop_origin
  for all
  using  (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.shop_origin from anon, authenticated;

-- v_agentic_catalog: product-feed projection over the owned catalog. Excludes out-of-stock.
--
-- Column adjustments from grounding step (real sku_dim / inventory_level_fact schema):
--   plan: s.variant_external_id         → s.external_id AS variant_id
--         (sku_dim has no variant_external_id; Shopify variant GID lives in external_id)
--   plan: s.product_title, s.variant_title → dropped; sku_dim carries a single `title`
--         column (no product/variant split). Exposed as sku_title.
--   plan: coalesce(i.on_hand, 0)        → aggregated via CTE; inventory_level_fact stores
--         per-location rows with column `available` (not on_hand); summed across latest
--         snapshot per location, matching the v_skus_flat inv_by_sku pattern.
--   plan: join on i.variant_external_id = s.variant_external_id
--         → join on i.sku_id = s.id     (real FK: inventory_level_fact.sku_id → sku_dim.id)
--   plan: i.shop_id text                → uuid (both tables carry uuid shop_id)
create or replace view public.v_agentic_catalog
  with (security_invoker = true)
as
with latest_inv as (
  -- Latest available snapshot per (sku, location) — same pattern as v_skus_flat.
  select distinct on (i.sku_id, i.location_id)
         i.shop_id,
         i.sku_id,
         i.available
    from public.inventory_level_fact i
   order by i.sku_id, i.location_id, i.observed_at desc
),
inv_by_sku as (
  select li.shop_id,
         li.sku_id,
         sum(li.available)::integer as on_hand
    from latest_inv li
   group by li.shop_id, li.sku_id
)
select
  s.shop_id,
  s.external_id                     as variant_id,   -- plan: variant_external_id → real: external_id (Shopify GID)
  s.title                           as sku_title,    -- plan: product_title+variant_title → real: single title column
  s.retail_price_cents,
  s.currency,
  s.vendor,
  s.category,
  s.tags,
  coalesce(i.on_hand, 0)            as on_hand,
  s.inventory_tracked,
  s.inventory_policy
from public.sku_dim s
left join inv_by_sku i
  on i.shop_id = s.shop_id and i.sku_id = s.id  -- plan: join on variant_external_id → real: sku_id = s.id
where not (s.inventory_tracked and coalesce(i.on_hand, 0) <= 0 and s.inventory_policy = 'deny');
