-- mcp_oauth_codes: short-lived (60s) one-time authorization codes.
-- Stored only as sha256(code); raw code never persisted.

create table mcp_oauth_codes (
  code_hash      text primary key,                                                 -- sha256(code)
  client_id      text not null references mcp_oauth_clients(client_id) on delete cascade,
  shop_id        uuid not null references shops(id) on delete cascade,
  redirect_uri   text not null,                                                    -- bound at issue, verified at exchange
  code_challenge text not null,                                                    -- PKCE S256 challenge
  scopes         jsonb not null default '["read"]'::jsonb,
  state_hint     text,                                                             -- last 8 chars of client state (logging only)
  expires_at     timestamptz not null,                                             -- now() + 60s
  consumed_at    timestamptz,                                                      -- single-use marker
  created_at     timestamptz not null default now()
);

create index mcp_oauth_codes_cleanup_idx on mcp_oauth_codes (expires_at);

alter table mcp_oauth_codes enable row level security;
revoke all on table mcp_oauth_codes from anon, authenticated;
