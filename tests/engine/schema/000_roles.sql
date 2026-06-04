-- Supabase parity roles for the engine test database.
--
-- The engine schema migrations (sourced from the Calderyn-Shopify monorepo's
-- supabase/migrations/) GRANT to and define RLS policies against the standard
-- Supabase roles. A bare postgres has none of them, so create them first.
-- Idempotent: safe to re-run against an existing test DB.
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;
