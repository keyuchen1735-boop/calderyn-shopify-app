-- Shipping completion (2026-07-09 design): merchant rate rules + flat rates + chosen service.
-- 1. ship_rules: the per-shop knobs the quote engine's MerchantShipRules layer already
--    implements (markup / handling fee / free-ship threshold) plus the shop handling window.
-- 2. ship_flat_rate: merchant-defined flat rates used when no live carrier is connected,
--    replacing the hardcoded fallback bands as the shop's authoritative no-carrier rates.
-- 3. orders.shipping_service: the buyer-chosen shipping option, persisted at checkout.
-- RLS pattern from 20260701120000_variant_shipping.sql: enable RLS, shop-scope via
-- current_shop_id(), revoke from anon/authenticated (service-role reaches it regardless).

create table if not exists public.ship_rules (
  shop_id                   uuid        primary key references public.shops(id) on delete cascade,
  markup_pct                numeric     not null default 0 check (markup_pct >= -100 and markup_pct <= 1000),
  handling_cents            int         not null default 0 check (handling_cents >= 0),
  free_ship_threshold_cents int         check (free_ship_threshold_cents is null or free_ship_threshold_cents >= 0),
  handling_days             int         not null default 1 check (handling_days >= 0 and handling_days <= 60),
  updated_at                timestamptz not null default now()
);
alter table public.ship_rules enable row level security;
create policy ship_rules_shop_scope on public.ship_rules
  for all
  using  (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.ship_rules from anon, authenticated;

create table if not exists public.ship_flat_rate (
  id               uuid        primary key default gen_random_uuid(),
  shop_id          uuid        not null references public.shops(id) on delete cascade,
  label            text        not null check (char_length(label) between 1 and 80),
  zone             text        not null default 'all' check (zone in ('domestic', 'international', 'all')),
  max_weight_oz    numeric     check (max_weight_oz is null or max_weight_oz > 0),
  amount_cents     int         not null check (amount_cents >= 0),
  est_transit_days int         check (est_transit_days is null or (est_transit_days >= 0 and est_transit_days <= 90)),
  position         int         not null default 0,
  updated_at       timestamptz not null default now()
);
create index if not exists ship_flat_rate_shop_idx on public.ship_flat_rate(shop_id);
alter table public.ship_flat_rate enable row level security;
create policy ship_flat_rate_shop_scope on public.ship_flat_rate
  for all
  using  (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.ship_flat_rate from anon, authenticated;

-- The buyer-chosen shipping option (e.g. "USPS Priority"), stamped at checkout origination.
-- Display-only: shipping_cents remains the charged amount.
alter table public.orders add column if not exists shipping_service text;
