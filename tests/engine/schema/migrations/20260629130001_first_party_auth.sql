-- First-party auth (Slice 0): users + membership + reset tokens, owned shop
-- identity decoupled from *.myshopify.com, and a user link on dashboard sessions.
-- Dual-run: existing Shopify-keyed rows/sessions keep working (shop_domain stays,
-- just no longer required; session.user_id is null for Shopify-path sessions).

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.users enable row level security;

create table if not exists public.membership (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  unique (user_id, shop_id)
);
create index if not exists membership_user_id_idx on public.membership(user_id);
create index if not exists membership_shop_id_idx on public.membership(shop_id);
alter table public.membership enable row level security;

create table if not exists public.password_reset_token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token_hash text not null unique,
  purpose text not null default 'reset' check (purpose in ('reset','set_password')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists password_reset_token_user_id_idx on public.password_reset_token(user_id);
alter table public.password_reset_token enable row level security;

-- Owned shop identity.
alter table public.shops add column if not exists org_slug text;
alter table public.shops add column if not exists display_name text;
alter table public.shops add column if not exists custom_domain text;
alter table public.shops add column if not exists billing_customer_id text;
create unique index if not exists shops_org_slug_key on public.shops(org_slug) where org_slug is not null;
alter table public.shops alter column shop_domain drop not null;

-- First-party sessions link to a user; Shopify-path sessions leave it null.
-- Guarded with to_regclass: the dashboard_sessions table exists in the app/prod
-- schema but NOT in the engine test schema, which loads this same migration
-- under ON_ERROR_STOP=1. The guard lets the engine load skip these cleanly.
do $$
begin
  if to_regclass('public.dashboard_sessions') is not null then
    alter table public.dashboard_sessions add column if not exists user_id uuid references public.users(id) on delete cascade;
    create index if not exists dashboard_sessions_user_id_idx on public.dashboard_sessions(user_id);
    -- First-party session inserts omit shop_domain (no Shopify domain); it was
    -- NOT NULL for the Shopify path, so relax it so owned sessions can insert.
    alter table public.dashboard_sessions alter column shop_domain drop not null;
  end if;
end $$;
