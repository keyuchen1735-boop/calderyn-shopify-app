-- oauth_state: single-use CSRF nonces for ad-platform OAuth connect flows (Meta
-- first). A row is minted when a merchant starts "Connect" (carried as the OAuth
-- `state` param) and deleted on callback — see app/lib/meta/oauth-state.server.ts.
-- This replaces the previous static HMAC-of-shop `state`, which never rotated and
-- could be replayed. Shop-scoped in code (service-role); RLS deferred.
--
-- nonce is the primary key, so a replayed nonce finds no row after consume.
-- shop_id FK is ON DELETE CASCADE to honour the GDPR-redact schema invariant
-- (every per-shop table cascades from shops; see app/lib/gdpr/sweep.server.ts).
-- Expiry (10 min) is enforced in code against created_at; stale rows are also
-- removed when the shop is redacted or can be trimmed by a future retention pass.

create table if not exists public.oauth_state (
  nonce       text primary key,
  shop_id     uuid not null references shops(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create index if not exists oauth_state_shop_idx on public.oauth_state (shop_id);

-- RLS on, no policies — matches the rest of the schema. The app reaches this
-- table only via the service-role key (which bypasses RLS); the anon/authenticated
-- roles have no policy and are denied. This avoids leaving oauth_state exposed to
-- the anon role the way public.mcp_tokens currently is.
alter table public.oauth_state enable row level security;
