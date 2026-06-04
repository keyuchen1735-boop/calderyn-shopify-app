-- Plan 05 Task 2 — moat_keys schema for pseudonym mapping.
--
-- The pseudonym → shop_id reverse mapping lives in its own schema so we
-- can grant SELECT on it to a *different* role (``app_pseudonymizer``)
-- than the role used by the web app (``app_web``) or the engine
-- (``app_engine``). This makes "leak of moat events alone" not enough to
-- re-identify a tenant — an attacker would also need access to
-- moat_keys.shop_pseudonym, which is only available under the
-- pseudonymizer role.
--
-- The role grants themselves are NOT created in this migration. Plan 05
-- Phase C Task 22 (`036_moat_role_grants.sql` in the original plan
-- numbering) creates app_web / app_engine / app_pseudonymizer and wires
-- the SELECT/INSERT grants. Until that migration ships, no app role can
-- read from this schema (we revoke from PUBLIC below); the engine and
-- web emitters use the database superuser role at this stage.

create schema if not exists moat_keys;

create table moat_keys.shop_pseudonym (
  shop_id        uuid primary key references public.shops(id) on delete cascade,
  pseudonym_id   text not null unique,
  pepper_version int  not null default 1,
  created_at     timestamptz not null default now()
);

-- Hard floor: nothing on PUBLIC can see this schema. Phase C will add
-- the per-role grants for app_pseudonymizer (SELECT) and the controlled
-- INSERT path for the emitter.
revoke all on schema moat_keys from public;
revoke all on all tables in schema moat_keys from public;
