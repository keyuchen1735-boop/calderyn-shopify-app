-- Guest buyer identity (platform pivot #1): a net-new, buyer-side PII store that sits
-- DELIBERATELY OUTSIDE the analytics warehouse. Hard invariant: order_fact / the warehouse
-- NEVER gains a buyer-PII column — buyer email/phone/address/consent live here and only here.
-- Guest-only: no password, no login (the account upgrade is a later step, #11).
--
-- RLS is modeled on ad_click_ref (20260606130000_attribution.sql) + the security-hardening
-- migration (20260619170000_security_audit_rls_hardening.sql): every table carries its OWN
-- shop_id and a `shop_id = current_shop_id()` policy, and anon/authenticated grants are
-- revoked. Like ad_click_ref (which carries shop_id alongside its order_fact FK) and
-- transaction_ledger (which carries shop_id alongside its payment_intent FK), the child
-- tables buyer_address / buyer_consent carry their OWN shop_id so the RLS policy is a direct
-- shop-equality check, not a cross-table subquery.
--
-- App access path: the app reaches these tables only via the service-role key (BYPASSRLS),
-- threading shop_id explicitly on every read/write (exactly like payment_intent /
-- transaction_ledger / ad_click_ref). The current_shop_id() policies are the buyer-scoped
-- RLS guard for any PostgREST (anon/authenticated) path: anon cannot set the app.shop_id GUC
-- (EXECUTE on set_current_shop_id was revoked in 20260604150000), so current_shop_id()
-- resolves to NULL for those roles and the policy denies every row. `for all` with both
-- using + with check mirrors assistant_rls (the other service-role-written PII surface).

-- 1) buyer_dim: one guest buyer per shop. email_normalized is lowercase+trim'd by the app
--    BEFORE write; unique per shop. phone is optional (stored as-given, no i18n).
create table public.buyer_dim (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  email_normalized text not null,
  phone            text,
  created_at       timestamptz not null default now(),
  unique (shop_id, email_normalized),
  -- Composite-FK target: lets child tables reference (shop_id, id) so a buyer can never
  -- be attached to a row whose shop_id disagrees with the buyer's own shop (the service-role
  -- write path bypasses RLS, so this FK is the only thing that catches a mismatched pair).
  unique (shop_id, id)
);
create index buyer_dim_shop_idx on public.buyer_dim (shop_id, created_at desc);

alter table public.buyer_dim enable row level security;
create policy buyer_dim_shop_scope on public.buyer_dim
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.buyer_dim from anon, authenticated;

-- 2) buyer_address: flat (no i18n) shipping/billing addresses. At most one default per
--    (buyer, kind) is enforced by the partial unique index below; the app clears the prior
--    default before inserting a new one, and the index is the hard guard (a concurrent
--    double-default insert fails visibly rather than silently producing two defaults).
create table public.buyer_address (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops(id) on delete cascade,
  buyer_id   uuid not null,
  kind       text not null check (kind in ('shipping','billing')),
  name       text,
  line1      text,
  line2      text,
  city       text,
  region     text,
  postal     text,
  country    text,
  phone      text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  -- Composite FK enforces buyer_id and shop_id refer to the SAME buyer's shop: an address
  -- can never point at a buyer that belongs to a different tenant (cross-tenant guard).
  foreign key (shop_id, buyer_id) references public.buyer_dim (shop_id, id) on delete cascade
);
create index buyer_address_buyer_idx on public.buyer_address (buyer_id, kind);
create unique index buyer_address_one_default
  on public.buyer_address (buyer_id, kind) where is_default;

alter table public.buyer_address enable row level security;
create policy buyer_address_shop_scope on public.buyer_address
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.buyer_address from anon, authenticated;

-- 3) buyer_consent: append-only consent proof. `accepted` is the ToS/privacy acceptance or
--    the marketing opt-in boolean; version + captured_at are the timestamped proof of WHICH
--    policy text was accepted; source_ip + ua capture WHO/WHERE accepted (legal proof). Never
--    updated — a withdrawal is a NEW row with accepted=false.
create table public.buyer_consent (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  buyer_id    uuid not null,
  policy      text not null check (policy in ('tos','privacy','marketing')),
  version     text not null,
  accepted    boolean not null,
  source_ip   text,
  ua          text,
  captured_at timestamptz not null default now(),
  -- Composite FK: same cross-tenant guard as buyer_address — consent can never be recorded
  -- against a buyer that belongs to a different shop than the row's shop_id.
  foreign key (shop_id, buyer_id) references public.buyer_dim (shop_id, id) on delete cascade
);
create index buyer_consent_buyer_idx on public.buyer_consent (buyer_id, policy, captured_at desc);

alter table public.buyer_consent enable row level security;
create policy buyer_consent_shop_scope on public.buyer_consent
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.buyer_consent from anon, authenticated;
