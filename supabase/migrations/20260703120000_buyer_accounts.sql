-- Buyer accounts, login & saved profile (platform pivot #1b). Upgrades the guest buyer (#1)
-- into a real ACCOUNT: passwordless magic-link login, a buyer SESSION primitive that is fully
-- separate from the merchant dashboard session (own table + own cookie namespace), and saved
-- payment methods vaulted in Stripe. Order history + saved addresses reuse the tables that
-- already exist (public.orders, public.buyer_address) — no new tables for those.
--
-- Hardened-migration pattern, identical to buyer_identity (20260629100000) and order_spine
-- (20260629110000): every table carries its OWN shop_id; RLS `for all` with BOTH using +
-- with check against current_shop_id(); anon/authenticated grants revoked; and each table
-- uses a COMPOSITE FK `(shop_id, buyer_id) references buyer_dim (shop_id, id)` so a cross-tenant
-- (shop_id, buyer_id) pair is rejected even on the BYPASSRLS service-role write path (the app
-- reaches these tables only via the service-role key, threading shop_id explicitly on every
-- read/write, so the composite FK is the only thing that catches a mismatched pair).
--
-- Hard PII invariant (unchanged): buyer PII lives here and in the buyer_* tables ONLY — never
-- in the analytics warehouse (order_fact). ON DELETE CASCADE on the composite FKs means a
-- buyer deletion (delete of the buyer_dim row) cascade-removes magic links, sessions, and saved
-- payment-method records automatically; the warehouse facts (which hold no buyer PII) are a
-- separate spine and are untouched by that cascade.

-- 0) buyer_dim gains a Stripe Customer link. One Customer per buyer, created lazily the first
--    time the buyer saves a card (SetupIntent flow). Kept on buyer_dim (not on the per-card
--    rows) so the Customer id survives with ZERO saved cards and a SetupIntent can always
--    resolve it. Nullable: a guest who never saves a card never gets a Customer. Shop-scoped by
--    living on buyer_dim, which already carries shop_id + its RLS policy.
alter table public.buyer_dim
  add column stripe_customer_id text;

-- 1) buyer_magic_link: single-use, short-lived (15 min) passwordless login token. Only the
--    HMAC-SHA256 hash of the raw token is stored (same posture as dashboard_sessions /
--    password_reset_token) — the raw token lives only in the emailed link. consumed_at is the
--    single-use guard: consume claims it atomically (consumed_at IS NULL) so a token works once.
create table public.buyer_magic_link (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  buyer_id    uuid not null,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now(),
  foreign key (shop_id, buyer_id) references public.buyer_dim (shop_id, id) on delete cascade
);
create index buyer_magic_link_buyer_idx on public.buyer_magic_link (shop_id, buyer_id, created_at desc);

alter table public.buyer_magic_link enable row level security;
create policy buyer_magic_link_shop_scope on public.buyer_magic_link
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.buyer_magic_link from anon, authenticated;

-- 2) buyer_session: the buyer-side session primitive. Mirrors dashboard_sessions
--    (20260609130000) but is a SEPARATE namespace targeting BUYERS, not merchants — its own
--    table, its own cookie (__Host-calderyn_buyer, distinct from the dashboard's __Host-calderyn_dash).
--    The cookie carries the RAW opaque token; only its peppered HMAC-SHA256 hash is stored here.
--    revoked_at makes a session killable (logout, account deletion) without deleting the row.
create table public.buyer_session (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops(id) on delete cascade,
  buyer_id   uuid not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  foreign key (shop_id, buyer_id) references public.buyer_dim (shop_id, id) on delete cascade
);
create index buyer_session_buyer_idx on public.buyer_session (shop_id, buyer_id);

alter table public.buyer_session enable row level security;
create policy buyer_session_shop_scope on public.buyer_session
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.buyer_session from anon, authenticated;

-- 3) buyer_payment_method: a saved card, VAULTED IN STRIPE. This table stores ONLY Stripe's
--    non-sensitive display fields (brand / last4 / exp) plus the Stripe ids — NEVER a PAN, CVV,
--    or any raw card data, so PCI scope is not expanded (the card lives in Stripe). detached_at
--    soft-deletes a removed card (the Stripe PaymentMethod is detached in the app path) so a
--    once-saved card stays auditable without leaving a usable saved card behind.
create table public.buyer_payment_method (
  id                        uuid primary key default gen_random_uuid(),
  shop_id                   uuid not null references public.shops(id) on delete cascade,
  buyer_id                  uuid not null,
  stripe_customer_id        text not null,
  stripe_payment_method_id  text not null,
  brand                     text,
  last4                     text,
  exp_month                 integer,
  exp_year                  integer,
  created_at                timestamptz not null default now(),
  detached_at               timestamptz,
  -- A Stripe PaymentMethod id is globally unique and belongs to one Customer; unique per shop so
  -- an idempotent SetupIntent-return refresh upserts rather than inserting a duplicate saved card.
  unique (shop_id, stripe_payment_method_id),
  foreign key (shop_id, buyer_id) references public.buyer_dim (shop_id, id) on delete cascade
);
create index buyer_payment_method_buyer_idx on public.buyer_payment_method (shop_id, buyer_id, created_at desc);

alter table public.buyer_payment_method enable row level security;
create policy buyer_payment_method_shop_scope on public.buyer_payment_method
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.buyer_payment_method from anon, authenticated;
