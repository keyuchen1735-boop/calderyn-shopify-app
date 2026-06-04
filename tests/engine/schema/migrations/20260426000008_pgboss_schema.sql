-- supabase/migrations/20260426000007_pgboss_schema.sql
-- Plan 02 Task 2: reserve a dedicated namespace for pg-boss.
-- pg-boss creates its own tables on first start; we just carve the schema and grant usage.

create schema if not exists pgboss;
grant usage on schema pgboss to postgres, service_role;
grant create on schema pgboss to service_role;

-- workers connect under service_role and pg-boss will issue its DDL on boot.
