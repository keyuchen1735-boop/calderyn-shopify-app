-- Plan 05 Task 22 — role grants enforcing moat isolation.
--
-- This migration is the load-bearing one for CLAUDE.md invariant
-- #5: "moat isolation via Postgres roles, not application logic".
-- It creates three application roles and the privilege boundary
-- between them, so that:
--
--   * ``app_web``  — the role used by the Remix app (apps/web).
--                    Can read and write public.* (RLS-scoped).
--                    CANNOT touch moat.* or moat_keys.*.
--   * ``app_engine`` — the role used by the Python detection engine
--                      and the Node workers. Can INSERT into
--                      moat.event_log (so the emitter writes).
--                      CANNOT read moat_keys.shop_pseudonym.
--   * ``app_pseudonymizer`` — the bridge role. The ONLY role that
--                              can SELECT/INSERT
--                              moat_keys.shop_pseudonym. Used by a
--                              narrow service path that materializes
--                              the pseudonym for a known shop_id
--                              (and refuses to enumerate).
--
-- Idempotent role creation lets the migration run cleanly on a fresh
-- database (no roles yet) AND on a Supabase project where roles may
-- pre-exist.

do $$ begin
  create role app_web noinherit;
  exception when duplicate_object then null;
end $$;
do $$ begin
  create role app_engine noinherit;
  exception when duplicate_object then null;
end $$;
do $$ begin
  create role app_pseudonymizer noinherit;
  exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- public schema — the Remix app's home turf. RLS handles per-tenant
-- isolation; here we just hand out the table-level grants both roles
-- need.
-- ---------------------------------------------------------------------------

grant usage on schema public to app_web, app_engine;
grant select, insert, update, delete on all tables in schema public
  to app_web, app_engine;
grant usage, select on all sequences in schema public
  to app_web, app_engine;
alter default privileges in schema public
  grant select, insert, update, delete on tables to app_web, app_engine;
alter default privileges in schema public
  grant usage, select on sequences to app_web, app_engine;

-- ---------------------------------------------------------------------------
-- moat schema — engine writes, web is forbidden.
-- ---------------------------------------------------------------------------

grant usage on schema moat to app_engine;
grant insert on moat.event_log to app_engine;
-- Engine also needs SELECT on event_log (for the trainer-side reads
-- when the trainer runs in-process) and the supporting tables that
-- Tasks 10/15/17/21 created.
grant select on moat.event_log               to app_engine;
grant select, insert, update on moat.detection_models to app_engine;
grant select, insert, update on moat.peer_baselines   to app_engine;
grant select, insert, update on moat.incident_library to app_engine;
grant select on moat.shop_metrics_rollup     to app_engine;

-- moat.event_log uses a bigserial id which means INSERT also needs
-- USAGE/SELECT on the backing sequence. Grant sequence privs across
-- the whole schema so future tables (e.g. Plan 06's moat.confirmed_loss
-- if it ever lands) inherit the grant via default privileges.
grant usage, select on all sequences in schema moat to app_engine;
alter default privileges in schema moat
  grant usage, select on sequences to app_engine;

-- Belt-and-suspenders: revoke any access app_web might have inherited
-- from PUBLIC or via default privileges.
revoke all on schema moat from public;
revoke all on schema moat from app_web;
revoke all on all tables in schema moat from app_web;

-- ---------------------------------------------------------------------------
-- moat_keys schema — the most sensitive surface. Only the
-- pseudonymizer role gets in.
-- ---------------------------------------------------------------------------

revoke all on schema moat_keys from public;
revoke all on schema moat_keys from app_web;
revoke all on schema moat_keys from app_engine;
revoke all on all tables in schema moat_keys from public, app_web, app_engine;

grant usage  on schema moat_keys                   to app_pseudonymizer;
grant select on moat_keys.shop_pseudonym           to app_pseudonymizer;
grant insert on moat_keys.shop_pseudonym           to app_pseudonymizer;

-- The pseudonymizer also needs USAGE on the public schema so it can
-- resolve a shop_id → pseudonym lookup that joins moat_keys against
-- public.shops (e.g. consent-purge code paths).
grant usage  on schema public                      to app_pseudonymizer;
grant select on public.shops                       to app_pseudonymizer;
