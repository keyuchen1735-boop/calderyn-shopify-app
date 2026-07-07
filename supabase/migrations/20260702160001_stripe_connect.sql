-- Stripe Connect (spec 2026-07-02 #11): per-shop Express connected account for
-- destination charges + auto payouts, with a per-shop application fee knob
-- (default 0 = pilot comp). RLS mirrors payment_intent: service-role writes
-- bypass RLS; current_shop_id() read policy for the authenticated path.

create table public.stripe_connected_account (
  id                         uuid primary key default gen_random_uuid(),
  shop_id                    uuid not null references public.shops(id) on delete cascade,
  stripe_account_id          text not null,          -- acct_...
  account_type               text not null default 'express',
  charges_enabled            boolean not null default false,
  payouts_enabled            boolean not null default false,
  details_submitted          boolean not null default false,
  application_fee_bps        integer not null default 0 check (application_fee_bps between 0 and 10000),
  application_fee_flat_cents integer not null default 0 check (application_fee_flat_cents >= 0),
  country                    text not null default 'US',
  default_currency           text not null default 'usd',
  onboarded_at               timestamptz,            -- first time fully enabled
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (shop_id),                                  -- one payout account per shop
  unique (stripe_account_id)
);

alter table public.stripe_connected_account enable row level security;
create policy stripe_connected_account_read on public.stripe_connected_account
  for select using (shop_id = public.current_shop_id());

-- Reconciliation truth on each PI: which charges auto-routed (acct_...) vs
-- platform charges still owed a manual payout; fee actually attached at create.
alter table public.payment_intent
  add column stripe_account_id     text,
  add column application_fee_cents integer;
