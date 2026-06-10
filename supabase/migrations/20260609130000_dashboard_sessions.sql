-- Sessions for the merchant web dashboard (calderyncompany.com/dashboard).
-- Only the HMAC-SHA256 hash of the opaque cookie token is stored.
-- Service-role access only; RLS enabled with no policies as a belt-and-braces
-- guard against accidental anon/authenticated grants.
create table if not exists public.dashboard_sessions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  shop_domain text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists dashboard_sessions_shop_id_idx
  on public.dashboard_sessions (shop_id);

alter table public.dashboard_sessions enable row level security;
