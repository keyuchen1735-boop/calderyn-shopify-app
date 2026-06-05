-- CRITICAL: close a live anon exposure of public.mcp_tokens.
--
-- mcp_tokens stores per-shop bearer-token HASHES (HMAC-SHA256) plus prefix/scope
-- metadata. It was created without RLS, and PostgREST exposed it to the anon and
-- authenticated roles with full table grants (verified live: rls_enabled=false,
-- anon/authenticated SELECT/INSERT/UPDATE/DELETE). Anyone holding the public anon
-- key could therefore read token hashes/prefixes and insert or delete tokens.
--
-- The app reaches this table only via the service-role key (BYPASSRLS), so
-- enabling RLS with NO policy (deny-all to non-bypass roles) and revoking the
-- anon/authenticated grants closes the hole without breaking anything. This
-- mirrors the oauth_state convention (RLS on, no policy = denied).
alter table public.mcp_tokens enable row level security;
revoke all on table public.mcp_tokens from anon, authenticated;
