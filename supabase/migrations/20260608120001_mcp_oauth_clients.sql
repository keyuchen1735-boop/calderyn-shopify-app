-- mcp_oauth_clients: one row per OAuth client (Claude.ai workspace, custom agent, etc.)
-- registered via RFC 7591 dynamic client registration.

create table mcp_oauth_clients (
  client_id                  text primary key,             -- 'cal_client_' + 16 random base32
  client_name                text not null,                -- from DCR payload
  redirect_uris              jsonb not null,               -- jsonb array of strings; validated against at issue + exchange
  token_endpoint_auth_method text not null default 'none',
  software_id                text,                         -- DCR optional
  software_version           text,
  created_at                 timestamptz not null default now(),
  last_used_at               timestamptz
);

alter table mcp_oauth_clients enable row level security;
revoke all on table mcp_oauth_clients from anon, authenticated;
