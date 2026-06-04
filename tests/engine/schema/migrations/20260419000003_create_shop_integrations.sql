-- supabase/migrations/20260419000003_create_shop_integrations.sql
create type public.integration_kind as enum ('shopify', 'meta_ads', 'google_ads', 'quickbooks');

create table public.shop_integrations (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references public.shops(id) on delete cascade,
  kind               public.integration_kind not null,
  access_token_enc   bytea,      -- encrypted with pgp_sym_encrypt; never store plaintext
  refresh_token_enc  bytea,
  scopes             text[] not null default '{}',
  connected_at       timestamptz,
  last_sync_at       timestamptz,
  sync_status        text not null default 'pending',   -- pending | backfilling | live | error
  sync_error         text,
  external_account_id text,      -- e.g. Meta ad account id
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (shop_id, kind)
);

alter table public.shop_integrations enable row level security;

create index shop_integrations_shop_idx on public.shop_integrations (shop_id);
