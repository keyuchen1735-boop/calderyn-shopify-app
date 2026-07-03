-- Step 10 (enforcement half): make "every read view is security_invoker" a
-- structurally-enforced invariant instead of a per-migration convention.
--
-- WHY. Read views over tenant tables must run with security_invoker = on so the
-- QUERYING role's RLS applies (20260604140000 first established this). The trap:
-- `create or replace view ... as` WITHOUT a `with (security_invoker = ...)`
-- clause RESETS reloptions, silently dropping the setting and reverting the view
-- to SECURITY DEFINER — which bypasses the base tables' RLS. Every redefinition
-- in this repo re-asserts the clause by hand; a single omission reopens the
-- cross-tenant read path. This migration re-asserts the setting idempotently and
-- adds a self-test that fails the apply if any v_* view is definer-owned outside
-- a documented allowlist.
--
-- SAFE. Re-asserting security_invoker on a view that already has it is a no-op;
-- the app + engine read as service_role / postgres (BYPASSRLS), unaffected. No
-- view body changes.
--
-- DOCUMENTED DEFINER ALLOWLIST. v_peer_metric_baselines is intentionally
-- SECURITY DEFINER (20260617000000): it exposes k-anonymized cross-shop peer
-- benchmarks (metric_key, segment, p25/p50/p75, n, computed_at) with NO shop_id
-- and no per-shop rows, reading moat.peer_metric_baselines under the owner so the
-- read path needs no moat grant. Its only readers are BYPASSRLS roles
-- (anon/authenticated grants were revoked in 20260702120000), so it is not a
-- cross-tenant leak. Flipping it to invoker would break the benchmark read path.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- 1. Re-assert security_invoker on every public v_* view except the documented
--    definer allowlist. Idempotent.
do $$
declare v record;
begin
  for v in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relkind = 'v'
      and c.relname like 'v\_%'
      and c.relname <> all (array['v_peer_metric_baselines'])
  loop
    execute format('alter view public.%I set (security_invoker = on)', v.relname);
  end loop;
end $$;

-- 2. Self-test: no public v_* view is definer-owned outside the allowlist.
do $$
declare offenders text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into offenders
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relkind = 'v'
    and c.relname like 'v\_%'
    and c.relname <> all (array['v_peer_metric_baselines'])
    and coalesce(
      (select option_value from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'),
      'false'
    ) not in ('true','on');
  if offenders is not null then
    raise exception 'v_* views not security_invoker (cross-tenant read risk): %', offenders;
  end if;
end $$;
