-- CRITICAL: close a live anon exposure of public.integration_credentials.
--
-- integration_credentials stores AES-256-GCM encrypted ad-platform OAuth tokens.
-- The 20260601010000 migration created it without RLS, so PostgREST exposed it to
-- the anon and authenticated roles with full table grants (verified live:
-- rls_enabled=false, anon/authenticated SELECT/INSERT/UPDATE/DELETE). Anyone with
-- the public anon key could read account ids / token expiry and insert, delete,
-- or overwrite stored credential rows.
--
-- The app reaches this table only via the service-role key (BYPASSRLS), so
-- enabling RLS with NO policy (deny-all to non-bypass roles) and revoking the
-- anon/authenticated grants closes the hole without breaking anything. Mirrors
-- the mcp_tokens_rls / oauth_state convention (RLS on, no policy = denied).
alter table public.integration_credentials enable row level security;
revoke all on table public.integration_credentials from anon, authenticated;
