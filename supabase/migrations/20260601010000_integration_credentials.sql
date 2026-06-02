-- integration_credentials: encrypted long-lived OAuth tokens for ad-platform
-- integrations (Meta first). Secrets live here, separate from shop_integrations
-- metadata. Token is AES-256-GCM encrypted at rest (app/lib/crypto.server.ts).

create table if not exists public.integration_credentials (
  shop_id uuid not null references shops(id) on delete cascade,
  kind integration_kind not null,
  access_token_encrypted text not null,
  token_expires_at timestamptz,
  external_account_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, kind)
);
