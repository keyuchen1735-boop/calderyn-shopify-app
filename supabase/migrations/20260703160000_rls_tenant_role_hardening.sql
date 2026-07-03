-- Step 10 (enforcement half): tighten the non-bypass tenant role into a real
-- read lane and wire it so PostgREST can reach it.
--
-- CONTEXT. 20260702120000 completed the POLICY layer: every tenant table has a
-- `shop_id = current_shop_id()` policy, secret/global tables are deny-all, and
-- current_shop_id() reads the `app.shop_id` session GUC
-- (`nullif(current_setting('app.shop_id', true), '')::uuid`). But those policies
-- are dormant: every live consumer connects as service_role/postgres (BYPASSRLS).
-- The one non-bypass role that already exists, `app_web` (NOBYPASSRLS, NOLOGIN),
-- was over-provisioned — it holds a direct GRANT ALL (select+insert+update+
-- delete) from postgres on all ~134 public relations, INCLUDING the 22 deny-all
-- secret/global tables (integration_credentials, app_secret, users, mcp_tokens,
-- oauth_state, password_reset_token, ...). RLS-with-no-policy blocks reads today,
-- but a write-everything grant on secret tables is exactly the "gains a grant"
-- risk the deny-all posture exists to remove, and it makes app_web a read+write
-- role rather than the SELECT-only dashboard/read lane the design calls for.
--
-- WHAT THIS DOES. Resets app_web to least privilege: SELECT only, and only on
-- policy-covered tenant tables (never the deny-all set), no write anywhere; makes
-- authenticator a member of app_web so a role=app_web JWT can be minted for the
-- non-bypass PostgREST read lane (getTenantSupabase); and fixes default
-- privileges so future tables are not auto-granted to app_web.
--
-- WHY THIS BREAKS NOTHING. app_web is NOLOGIN and is referenced by zero
-- application code (only migration self-tests name it); authenticator was NOT a
-- member, so nothing could switch into it. service_role/postgres are unchanged
-- and keep BYPASSRLS, so the app, engine, cron ETL, and Prisma session storage
-- are untouched. This migration only REDUCES app_web's privilege and adds a
-- dormant, fail-closed read lane. No app-code behavior change.
--
-- ADOPTION. current_shop_id() reads a session GUC, and PostgREST pools
-- connections, so a plain `.from().select()` on the app_web lane cannot set
-- app.shop_id for its own statement — it returns ZERO rows (fail-closed), never
-- cross-tenant data. Real enforcement through this lane therefore comes from
-- tenant-scoped SECURITY INVOKER RPCs that call
-- `set_config('app.shop_id', p_shop_id, true)` and run their query in the same
-- transaction; app_web being NOBYPASSRLS makes the shop_id policies bind. New
-- tenant tables must `grant select ... to app_web` alongside their RLS policy
-- (self-test 6 below warns on drift).

set lock_timeout = '5s';
set statement_timeout = '120s';

-- ============================================================================
-- 1. Reset app_web to least privilege, then re-grant the SELECT-only read lane.
-- ============================================================================
revoke all on all tables    in schema public from app_web;
revoke all on all sequences  in schema public from app_web;
revoke all on all functions  in schema public from app_web;

alter role app_web nobypassrls;         -- belt: intended posture, already set
grant usage on schema public to app_web;

-- SELECT on every policy-covered tenant table that is NOT in the deny-all set.
-- Dynamic so it covers all Group P / Group F / *_fact / *_dim / buyer_* tables
-- without a hand-maintained list, and automatically excludes the secret/global
-- tables (which carry RLS-with-no-policy and must hold NO app_web grant).
do $$
declare t record;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relkind = 'r'
      and exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
      and c.relname <> all (array[
        -- deny-all allowlist (Group D, 22) — mirrors app/lib/security/tenant-tables.ts
        'integration_credentials','mcp_oauth_codes','mcp_tokens','oauth_state',
        'dashboard_sessions','membership','admin_access_log','app_secret',
        'email_optouts','linkedin_connection','mcp_oauth_clients','mcp_pending_oauth',
        'password_reset_token','pilot_invites','rate_limit_hits','shopify_sessions',
        'shopify_sessions_migrations','social_digest','social_link_post','users',
        'waitlist','waitlist_rate_limit'
      ])
  loop
    execute format('grant select on public.%I to app_web', t.relname);
  end loop;
end $$;

-- ============================================================================
-- 2. Make authenticator a member of app_web so PostgREST can SET ROLE app_web
--    for a minted role=app_web JWT (the non-bypass read lane). Safe: app_web is
--    now SELECT-only + fail-closed, and minting requires the server-only JWT
--    secret.
-- ============================================================================
grant app_web to authenticator;

-- ============================================================================
-- 3. Default privileges: future postgres-owned tables are NOT auto-granted to
--    app_web (explicit grants only, so a future secret table is never exposed).
-- ============================================================================
alter default privileges for role postgres in schema public revoke all on tables    from app_web;
alter default privileges for role postgres in schema public revoke all on sequences  from app_web;
alter default privileges for role postgres in schema public revoke execute on functions from app_web;

-- ============================================================================
-- 4. Self-tests. Any RAISE EXCEPTION rolls back the entire migration.
-- ============================================================================

-- 4a. No write anywhere: app_web must hold zero INSERT/UPDATE/DELETE on any
--     public table.
do $$
declare bad int;
begin
  select count(*) into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relkind = 'r'
    and has_table_privilege('app_web', c.oid, 'insert,update,delete');
  if bad > 0 then
    raise exception 'self-test 4a: app_web retains write privilege on % table(s)', bad;
  end if;
end $$;

-- 4b. Deny-all tables stay ungranted: app_web must not hold SELECT on any of the
--     22 secret/global tables.
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relkind = 'r'
    and c.relname = any (array[
      'integration_credentials','mcp_oauth_codes','mcp_tokens','oauth_state',
      'dashboard_sessions','membership','admin_access_log','app_secret',
      'email_optouts','linkedin_connection','mcp_oauth_clients','mcp_pending_oauth',
      'password_reset_token','pilot_invites','rate_limit_hits','shopify_sessions',
      'shopify_sessions_migrations','social_digest','social_link_post','users',
      'waitlist','waitlist_rate_limit'])
    and has_table_privilege('app_web', c.oid, 'select');
  if bad is not null then
    raise exception 'self-test 4b: app_web can still SELECT deny-all tables: %', bad;
  end if;
end $$;

-- 4c. Positive control + posture: app_web CAN read a representative tenant table
--     and is NOBYPASSRLS.
do $$
begin
  if not has_table_privilege('app_web', 'public.product_dim', 'select') then
    raise exception 'self-test 4c: app_web lost SELECT on product_dim (read lane broken)';
  end if;
  if (select rolbypassrls from pg_roles where rolname = 'app_web') then
    raise exception 'self-test 4c: app_web has BYPASSRLS (would defeat the lane)';
  end if;
end $$;

-- 4d. Lane reachability: authenticator must be a member of app_web so a
--     role=app_web JWT can switch into it via PostgREST.
do $$
begin
  if not pg_has_role('authenticator', 'app_web', 'member') then
    raise exception 'self-test 4d: authenticator is not a member of app_web (PostgREST lane unreachable)';
  end if;
end $$;

-- 4e. Functional RLS isolation proof (real rows, positive control). As app_web
--     (NOBYPASSRLS), setting app.shop_id to shop A must show exactly shop A's
--     product_dim rows and ZERO of shop B's. Read-only: picks two existing
--     shops, writes nothing. Mirrors 20260702120000 self-test 5d; runs for real
--     here because postgres is a member of app_web.
do $$
declare
  shop_a uuid;
  shop_b uuid;
  seen_a int;
  seen_b_when_a int;
begin
  if not pg_has_role(current_user, 'app_web', 'member') then
    raise warning 'self-test 4e skipped: current role cannot SET ROLE app_web';
    return;
  end if;

  select shop_id into shop_a from public.product_dim
    group by shop_id having count(*) > 0 order by count(*) desc limit 1;
  select shop_id into shop_b from public.product_dim
    where shop_id <> shop_a group by shop_id having count(*) > 0 order by count(*) desc limit 1;
  if shop_a is null or shop_b is null then
    raise warning 'self-test 4e skipped: fewer than two shops own product_dim rows';
    return;
  end if;

  begin
    set local role app_web;
    perform set_config('app.shop_id', shop_a::text, true);
    select count(*) into seen_a from public.product_dim;
    select count(*) into seen_b_when_a from public.product_dim where shop_id = shop_b;
    reset role;
  exception when insufficient_privilege then
    reset role;
    raise warning 'self-test 4e skipped: app_web lacks read privilege on product_dim';
    return;
  end;

  if seen_a = 0 then
    raise exception 'self-test 4e: positive control saw zero rows (vacuous pass guard)';
  end if;
  if seen_b_when_a <> 0 then
    raise exception 'self-test 4e: cross-tenant leak - app_web in shop_a context saw % of shop_b rows', seen_b_when_a;
  end if;
end $$;

-- 4f. Drift detector (WARN only): every policy-covered non-deny-all tenant table
--     should be SELECTable by app_web. A table added later without a matching
--     grant does not fail the apply, but surfaces so the read lane can be kept
--     complete (new tenant tables must `grant select ... to app_web`).
do $$
declare missing text;
begin
  select string_agg(c.relname, ', ') into missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relkind = 'r'
    and exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
    and c.relname <> all (array[
      'integration_credentials','mcp_oauth_codes','mcp_tokens','oauth_state',
      'dashboard_sessions','membership','admin_access_log','app_secret',
      'email_optouts','linkedin_connection','mcp_oauth_clients','mcp_pending_oauth',
      'password_reset_token','pilot_invites','rate_limit_hits','shopify_sessions',
      'shopify_sessions_migrations','social_digest','social_link_post','users',
      'waitlist','waitlist_rate_limit'])
    and not has_table_privilege('app_web', c.oid, 'select');
  if missing is not null then
    raise warning 'self-test 4f: policy-covered tenant tables missing app_web SELECT (grant them): %', missing;
  end if;
end $$;
