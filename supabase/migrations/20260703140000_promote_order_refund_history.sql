-- Order + refund history promote (platform-pivot Step 9, #13.promote). promote_shop_from_mirror
-- promoted catalog + inventory opening balances but NOT the 12-month order/refund history the
-- mirror already holds (order_fact / order_line_fact / refund_fact), so at cutover the owned org
-- had no historical orders for analytics continuity.
--
-- REPRESENTATION DECISION (why dedicated imported_* tables, not the owned `orders` spine #2):
-- the owned `orders` table is the TRANSACTIONAL money-path system-of-record — buyer_id NOT NULL
-- (FK to buyer_dim), a constrained checkout state machine (cart|checkout_pending|paid|...),
-- composite (shop_id, id) FKs, and a per-order state-transition audit trail. The 12-month mirror
-- history carries NO customer identity (order_fact strips all buyer PII, #13.customers) and its
-- rows are terminal analytics facts, not live checkout state. Forcing them into `orders` would
-- demand synthetic buyers and a fabricated state mapping that pollutes the live SoT the checkout
-- reads. So historical orders land in dedicated, read-only imported_* tables (analytics
-- continuity), keeping the owned `orders` spine exclusively for real Calderyn-native checkout.
-- Refunds have a sane owned target here too (imported_refund), so they promote in the same pass.
--
-- Every table carries its own shop_id with a direct current_shop_id() RLS policy and revokes
-- anon/authenticated (matches import_run / 20260702120000). The app reaches them only via the
-- service-role key, threading shop_id explicitly; the policies are defense-in-depth.

-- 1) Historical order headers (one per mirrored order_fact). external_id is the Shopify Order GID,
--    the join + import_map bridge key. NO buyer linkage by construction (see decision above).
create table if not exists public.imported_order (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  external_id      text not null,
  order_number     text,
  financial_status text,
  currency         text not null default 'USD',
  total_cents      integer not null default 0,
  subtotal_cents   integer not null default 0,
  shipping_cents   integer not null default 0,
  tax_cents        integer not null default 0,
  discount_cents   integer not null default 0,
  processed_at     timestamptz,
  source_version   bigint,
  promoted_at      timestamptz not null default now(),
  unique (shop_id, external_id)
);
create index if not exists imported_order_shop_idx on public.imported_order (shop_id, processed_at desc);

alter table public.imported_order enable row level security;
revoke all on public.imported_order from anon, authenticated;
drop policy if exists imported_order_shop_scope on public.imported_order;
create policy imported_order_shop_scope on public.imported_order
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

-- 2) Historical order lines. sku_id mirrors order_line_fact (references sku_dim; sku_dim.id ==
--    variant_dim.id, so it doubles as the owned-variant link) and is set null if the sku is gone.
create table if not exists public.imported_order_line (
  id                       uuid primary key default gen_random_uuid(),
  shop_id                  uuid not null references public.shops(id) on delete cascade,
  imported_order_id        uuid not null references public.imported_order(id) on delete cascade,
  sku_id                   uuid references public.sku_dim(id) on delete set null,
  external_line_id         text not null,
  quantity                 integer not null,
  price_cents              integer not null default 0,
  total_cents              integer not null default 0,
  unit_cost_cents_snapshot integer,
  unique (imported_order_id, external_line_id)
);
create index if not exists imported_order_line_order_idx on public.imported_order_line (shop_id, imported_order_id);

alter table public.imported_order_line enable row level security;
revoke all on public.imported_order_line from anon, authenticated;
drop policy if exists imported_order_line_shop_scope on public.imported_order_line;
create policy imported_order_line_shop_scope on public.imported_order_line
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

-- 3) Historical refunds (one per refunded line, keyed by external_line_id like refund_fact).
--    imported_order_id is nullable: a refund_fact may reference an order outside the promoted set.
create table if not exists public.imported_refund (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references public.shops(id) on delete cascade,
  imported_order_id uuid references public.imported_order(id) on delete set null,
  sku_id            uuid references public.sku_dim(id) on delete set null,
  external_id       text not null,
  external_line_id  text not null,
  quantity          integer not null,
  subtotal_cents    integer not null default 0,
  processed_at      timestamptz,
  source_version    bigint,
  promoted_at       timestamptz not null default now(),
  unique (shop_id, external_line_id)
);
create index if not exists imported_refund_shop_idx on public.imported_refund (shop_id, processed_at desc);

alter table public.imported_refund enable row level security;
revoke all on public.imported_refund from anon, authenticated;
drop policy if exists imported_refund_shop_scope on public.imported_refund;
create policy imported_refund_shop_scope on public.imported_refund
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

-- 4) import_map bridges historical ORDERS (1:1 by Shopify Order GID) so post-cutover order
--    webhooks dedup against the promoted row. Refunds are line-level (their Refund GID repeats
--    across lines, so it is not unique per row) — they are read-only continuity, not a
--    webhook-dedup entity, so they are deliberately NOT bridged. Extend the entity_type domain.
alter table public.import_map drop constraint if exists import_map_entity_type_check;
alter table public.import_map
  add constraint import_map_entity_type_check
  check (entity_type in ('product', 'variant', 'location', 'order'));

-- 5) Recreate promote_shop_from_mirror: catalog + inventory (unchanged) PLUS order/refund history
--    and the order bridge. Every insert is on-conflict-do-nothing so a re-promote converges.
create or replace function public.promote_shop_from_mirror(p_shop_id uuid) returns jsonb
  language plpgsql
  set search_path to ''
as $function$
declare
  c_products int;
  c_variants int;
  c_collections int;
  c_balances int;
  c_orders int;
  c_refunds int;
begin
  -- Catalog + collections (shared, idempotent). Runs before inventory so order
  -- lines resolve and variant_dim exists for the balance FK.
  perform public.promote_shop_catalog(p_shop_id);

  -- Inventory: seed inventory_balance.on_hand from the LATEST observation per
  -- (variant, location). Guarded so an orphan fact (variant/location not present
  -- in the owned tables) is skipped rather than failing the whole import.
  -- greatest(...,0): a negative observation (oversold mirror row) must not seed
  -- negative physical stock (matches the canonical inventory_seed clamp).
  insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand)
  select distinct on (f.sku_id, f.location_id)
    f.shop_id, f.sku_id, f.location_id, greatest(f.available, 0)
  from public.inventory_level_fact f
  where f.shop_id = p_shop_id
    and exists (select 1 from public.variant_dim v where v.id = f.sku_id)
    and exists (select 1 from public.location_dim l where l.id = f.location_id)
  order by f.sku_id, f.location_id, f.observed_at desc
  on conflict (variant_id, location_id) do nothing;

  -- Order history headers: copy order_fact 1:1 into imported_order.
  insert into public.imported_order (
    shop_id, external_id, order_number, financial_status, currency,
    total_cents, subtotal_cents, shipping_cents, tax_cents, discount_cents,
    processed_at, source_version)
  select
    o.shop_id, o.external_id, o.order_number, o.financial_status, o.currency,
    o.total_cents, o.subtotal_cents, o.shipping_cents, o.tax_cents, o.discount_cents,
    o.created_at_source, o.source_version
  from public.order_fact o
  where o.shop_id = p_shop_id
  on conflict (shop_id, external_id) do nothing;

  -- Order lines: resolve each order_line_fact to its promoted imported_order via the
  -- Shopify Order GID (order_line_fact.order_id -> order_fact.external_id -> imported_order).
  insert into public.imported_order_line (
    shop_id, imported_order_id, sku_id, external_line_id, quantity, price_cents,
    total_cents, unit_cost_cents_snapshot)
  select
    l.shop_id, io.id, l.sku_id, l.external_line_id, l.quantity, l.price_cents,
    l.total_cents, l.unit_cost_cents_snapshot
  from public.order_line_fact l
  join public.order_fact of on of.id = l.order_id
  join public.imported_order io on io.shop_id = of.shop_id and io.external_id = of.external_id
  where l.shop_id = p_shop_id
  on conflict (imported_order_id, external_line_id) do nothing;

  -- Refund history: copy refund_fact into imported_refund, resolving the (optional)
  -- imported_order via the same GID chain. left join keeps refunds whose order fell
  -- outside the promoted window (imported_order_id stays null) rather than dropping them.
  insert into public.imported_refund (
    shop_id, imported_order_id, sku_id, external_id, external_line_id, quantity,
    subtotal_cents, processed_at, source_version)
  select
    r.shop_id, io.id, r.sku_id, r.external_id, r.external_line_id, r.quantity,
    r.subtotal_cents, r.processed_at, r.source_version
  from public.refund_fact r
  left join public.order_fact of on of.id = r.order_id
  left join public.imported_order io on io.shop_id = r.shop_id and io.external_id = of.external_id
  where r.shop_id = p_shop_id
  on conflict (shop_id, external_line_id) do nothing;

  -- Bridge historical orders (1:1) into import_map for post-cutover webhook dedup.
  insert into public.import_map (shop_id, entity_type, external_id, owned_id)
  select io.shop_id, 'order', io.external_id, io.id
  from public.imported_order io
  where io.shop_id = p_shop_id
  on conflict (shop_id, entity_type, external_id) do nothing;

  select count(*) into c_products from public.product_dim where shop_id = p_shop_id;
  select count(*) into c_variants from public.variant_dim where shop_id = p_shop_id;
  select count(*) into c_collections from public.collection_dim where shop_id = p_shop_id;
  select count(*) into c_balances from public.inventory_balance where shop_id = p_shop_id;
  select count(*) into c_orders from public.imported_order where shop_id = p_shop_id;
  select count(*) into c_refunds from public.imported_refund where shop_id = p_shop_id;

  return jsonb_build_object(
    'products', c_products,
    'variants', c_variants,
    'collections', c_collections,
    'balances', c_balances,
    'orders', c_orders,
    'refunds', c_refunds
  );
end $function$;
