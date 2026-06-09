-- Extend mcp_tokens with OAuth-flow columns. Existing rows keep working
-- (auth_type defaults to 'bearer', other columns NULL).

alter table mcp_tokens
  add column auth_type    text not null default 'bearer' check (auth_type in ('bearer','oauth')),
  add column client_id    text references mcp_oauth_clients(client_id) on delete set null,
  add column expires_at   timestamptz,
  add column refresh_hash text;

create unique index mcp_tokens_refresh_hash_uq
  on mcp_tokens (refresh_hash)
  where refresh_hash is not null;

create index mcp_tokens_oauth_lookup_idx
  on mcp_tokens (client_id, shop_id)
  where auth_type = 'oauth' and revoked_at is null;
