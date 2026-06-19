-- Security audit (2026-06-19): support refresh-token reuse detection for MCP OAuth
-- grants. Retain the immediately-previous refresh-token hash so a replay of an
-- already-rotated refresh token is detectable and triggers grant revocation
-- (OAuth 2.1 / RFC 6819 sec 5.2.2.3). See app/lib/mcp_tokens.server.ts rotateRefreshToken.
alter table public.mcp_tokens add column if not exists prev_refresh_hash text;
create index if not exists mcp_tokens_prev_refresh_hash_idx
  on public.mcp_tokens (prev_refresh_hash) where prev_refresh_hash is not null;
