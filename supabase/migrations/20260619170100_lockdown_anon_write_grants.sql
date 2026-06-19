-- Security audit (2026-06-19) defense-in-depth: the anon/authenticated PostgREST
-- roles held broad write grants (INSERT/UPDATE/DELETE/TRUNCATE) on most public
-- tables. RLS (enabled, no policy) currently denies them, but those grants are a
-- latent landmine: any table that ever loses RLS or gains a permissive policy
-- would become world-writable. The app, engine, and marketing site reach Postgres
-- only via the service-role key (BYPASSRLS) or SECURITY DEFINER RPCs, never as the
-- anon/authenticated roles, so revoking these write grants breaks nothing.
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
