-- OLTP order spine + state machine (platform pivot #2a): the TRANSACTIONAL
-- system-of-record for Calderyn-native checkout. This is distinct from the
-- analytics warehouse `order_fact` — these tables are the SoT the warehouse is
-- emitted FROM (the emission itself is #2b/#2c, not here).
--
-- Hardened-migration pattern, identical to buyer_identity (20260629100000): every
-- table carries its OWN shop_id; RLS `for all` with BOTH using + with check against
-- current_shop_id(); anon/authenticated grants revoked; and CHILD tables use COMPOSITE
-- FKs `(shop_id, parent_id) references parent (shop_id, id)` so a cross-tenant
-- (shop_id, parent_id) pair is rejected even on the BYPASSRLS service-role write path
-- (the parent therefore carries `unique (shop_id, id)`). This is mandatory for a money
-- table: the app reaches these tables only via the service-role key, threading shop_id
-- explicitly on every read/write, so the composite FK is the only thing that catches a
-- mismatched (shop, parent) pair.
--
-- Money is integer cents throughout (matches payment_intent.amount_cents). State is
-- text + a check constraint, NOT a Postgres enum type — the codebase models every
-- bounded set this way (transaction_ledger.kind, buyer_address.kind), so convention wins.
-- The single state vocabulary shared by cart / checkout_session / order is:
--   cart | checkout_pending | paid | fulfilled | cancelled | refunded
-- The legal-transition state machine itself lives in app/lib/order/state.ts and is
-- enforced by transitionOrder(); this migration only constrains the column domain.
--
-- NOTE: the system-of-record table is named `orders` (plural) — NOT `order`, which is a
-- SQL reserved word that would force fragile double-quoting on the money path (and #2b
-- writes raw SQL / RPCs against it). The line/audit children keep the repo's singular
-- `_line` convention (order_line, order_state_transition) since neither is reserved.

-- 1) cart: an in-progress basket. buyer_id is NULL until checkout (guest browses
--    anonymously, then identifies at checkout). The composite FK to buyer_dim is
--    MATCH SIMPLE, so a NULL buyer_id skips the FK and a SET buyer_id is tenant-checked.
create table public.cart (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops(id) on delete cascade,
  buyer_id   uuid,
  state      text not null default 'cart'
             check (state in ('cart','checkout_pending','paid','fulfilled','cancelled','refunded')),
  created_at timestamptz not null default now(),
  -- Composite-FK target for cart_line / checkout_session (so a line/session can never
  -- attach to a cart whose shop_id disagrees with the child row's shop_id).
  unique (shop_id, id),
  -- COLUMN-SCOPED set null: on a buyer delete, null ONLY buyer_id (detach), keeping the
  -- cart + its NOT NULL shop_id. A bare `on delete set null` would try to null shop_id too
  -- and raise a not-null violation instead of detaching. (PG15+/Supabase.)
  foreign key (shop_id, buyer_id) references public.buyer_dim (shop_id, id) on delete set null (buyer_id)
);
create index cart_shop_idx on public.cart (shop_id, created_at desc);

alter table public.cart enable row level security;
create policy cart_shop_scope on public.cart
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.cart from anon, authenticated;

-- 2) cart_line: ONE line per variant per cart (enforced by the unique below; addCartLine
--    increments quantity on conflict). unit_price_cents + currency + title_snapshot are
--    SNAPSHOTTED from the catalog at add-to-cart time (the price/currency the buyer saw is
--    what they pay; a later catalog price OR currency change must not silently re-price or
--    re-denominate the cart).
create table public.cart_line (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  cart_id          uuid not null,
  variant_id       text not null,
  quantity         integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),  -- SNAPSHOT from catalog
  currency         text not null default 'usd',                     -- SNAPSHOT from catalog
  title_snapshot   text not null,                                   -- SNAPSHOT from catalog
  created_at       timestamptz not null default now(),
  unique (shop_id, cart_id, variant_id),
  foreign key (shop_id, cart_id) references public.cart (shop_id, id) on delete cascade
);
create index cart_line_cart_idx on public.cart_line (shop_id, cart_id);

alter table public.cart_line enable row level security;
create policy cart_line_shop_scope on public.cart_line
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.cart_line from anon, authenticated;

-- 3) checkout_session: the pricing snapshot taken when a buyer enters checkout.
--    shipping_cents + tax_cents are FLAT / MANUAL PLACEHOLDERS for the pilot — full
--    tax + shipping calculation is a later step. total = subtotal + shipping + tax,
--    computed by the app (not a generated column, to keep the write path simple).
create table public.checkout_session (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  cart_id        uuid not null,
  buyer_id       uuid not null,
  subtotal_cents integer not null,
  shipping_cents integer not null default 0,  -- FLAT placeholder (pilot); real calc later
  tax_cents      integer not null default 0,  -- FLAT placeholder (pilot); real calc later
  total_cents    integer not null,
  currency       text not null default 'usd',
  state          text not null default 'checkout_pending'
                 check (state in ('cart','checkout_pending','paid','fulfilled','cancelled','refunded')),
  created_at     timestamptz not null default now(),
  foreign key (shop_id, cart_id) references public.cart (shop_id, id) on delete cascade,
  foreign key (shop_id, buyer_id) references public.buyer_dim (shop_id, id) on delete cascade
);
create index checkout_session_cart_idx on public.checkout_session (shop_id, cart_id);
create index checkout_session_buyer_idx on public.checkout_session (shop_id, buyer_id);

alter table public.checkout_session enable row level security;
create policy checkout_session_shop_scope on public.checkout_session
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.checkout_session from anon, authenticated;

-- 4) orders: the system-of-record. Created at checkout (#2b), driven through its
--    lifecycle by transitionOrder(). attribution / external_gid / source_version are
--    placeholders the warehouse-emission step (#2b/#2c) populates — external_gid is the
--    eventual link to order_fact / Shopify; source_version is the monotonic version the
--    warehouse upsert keys off. financial_status mirrors Shopify's open-set string (kept
--    as free text, not a check, because its vocabulary is broad and money-driven by #2b).
create table public.orders (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  buyer_id         uuid not null,
  state            text not null default 'checkout_pending'
                   check (state in ('cart','checkout_pending','paid','fulfilled','cancelled','refunded')),
  subtotal_cents   integer not null,
  shipping_cents   integer not null default 0,  -- FLAT placeholder (pilot); real calc later
  tax_cents        integer not null default 0,  -- FLAT placeholder (pilot); real calc later
  total_cents      integer not null,
  currency         text not null default 'usd',
  financial_status text not null default 'pending',
  attribution      jsonb,
  external_gid     text,                          -- placeholder: link to order_fact / Shopify (#2b/#2c)
  source_version   bigint,                        -- placeholder: warehouse-emit version (#2b/#2c)
  created_at       timestamptz not null default now(),
  -- Composite-FK target for order_line / order_state_transition.
  unique (shop_id, id),
  foreign key (shop_id, buyer_id) references public.buyer_dim (shop_id, id) on delete cascade
);
create index orders_shop_idx on public.orders (shop_id, created_at desc);
create index orders_buyer_idx on public.orders (shop_id, buyer_id);

alter table public.orders enable row level security;
create policy orders_shop_scope on public.orders
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.orders from anon, authenticated;

-- 5) order_line: snapshotted lines copied from the cart at order creation (#2b).
create table public.order_line (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  order_id         uuid not null,
  variant_id       text not null,
  quantity         integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  title_snapshot   text not null,
  foreign key (shop_id, order_id) references public.orders (shop_id, id) on delete cascade
);
create index order_line_order_idx on public.order_line (shop_id, order_id);

alter table public.order_line enable row level security;
create policy order_line_shop_scope on public.order_line
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.order_line from anon, authenticated;

-- 6) order_state_transition: append-only audit trail. transitionOrder() writes exactly
--    one row per successful transition (rule 12: no silent state change). The composite
--    FK guarantees an audit row can never reference an order in another tenant.
create table public.order_state_transition (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  order_id    uuid not null,
  from_state  text not null,
  to_state    text not null,
  reason      text,
  occurred_at timestamptz not null default now(),
  foreign key (shop_id, order_id) references public.orders (shop_id, id) on delete cascade
);
create index order_state_transition_order_idx
  on public.order_state_transition (shop_id, order_id, occurred_at desc);

alter table public.order_state_transition enable row level security;
create policy order_state_transition_shop_scope on public.order_state_transition
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.order_state_transition from anon, authenticated;
