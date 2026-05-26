-- mcp_tokens: per-shop bearer tokens for the calderyn-mcp server.
-- Raw token shown to merchant once; hash stored at rest via HMAC-SHA256(raw, MCP_TOKEN_PEPPER).

create table mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  token_prefix text not null,
  scopes jsonb not null default '["read"]'::jsonb,
  created_by_user text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_user_agent text,
  revoked_at timestamptz
);

create index mcp_tokens_active_shop_idx
  on mcp_tokens (shop_id)
  where revoked_at is null;
