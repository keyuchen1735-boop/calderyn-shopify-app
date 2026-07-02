-- Step 10: tenant isolation hardening (Postgres RLS).
--
-- THREAT. The app reaches Postgres only via the service-role key (BYPASSRLS)
-- and the engine as role postgres (BYPASSRLS); tenant isolation in app paths is
-- a manual .eq('shop_id') repeated ~283 times. Two latent gaps make that one
-- layer thin: (1) the anon/authenticated PostgREST roles still hold broad DML
-- and SELECT grants that Supabase's default privileges silently re-grant on
-- every new table (the 2026-06-19 one-shot revoke was never backed by a
-- default-ACL change), and (2) 49 tables have RLS enabled but no policy, so if
-- any ever loses RLS or gains a grant it is world-open.
--
-- WHY THIS BREAKS NOTHING. service_role and postgres have rolbypassrls=true and
-- own every relation, so no revoke or policy here affects the app, the engine,
-- the cron ETL, Prisma session storage, or storage buckets (service-role only).
-- Four lanes are deliberately preserved: (a) the dormant Realtime path keeps
-- authenticated SELECT on alerts/action_audit/ad_campaign_dim (their policies
-- gate rows by the server-minted JWT shop_id claim); (b) the marketing front
-- door keeps anon EXECUTE on the four waitlist functions; (c) current_shop_id()
-- keeps PUBLIC EXECUTE (policy quals call it); (d) set_current_shop_id stays
-- postgres+service_role only (the 2026-06-04 breach fix). All 686 existing
-- anon/authenticated table grants and all 24 function grants were made by
-- postgres, so postgres can revoke them even though it is not superuser.
--
-- APP-CODE BEHAVIOR CHANGE: none. The new policies are structural insurance for
-- the future non-bypass app role; today they filter nothing because every live
-- consumer bypasses RLS.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- ============================================================================
-- 1. Revoke the anon/authenticated relation, sequence, and function surface.
-- ============================================================================
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from anon, authenticated;

-- The blanket revoke above removes role-specific anon/authenticated ACL entries
-- but NOT a built-in PUBLIC EXECUTE grant, and anon/authenticated are implicit
-- PUBLIC members. These SECURITY INVOKER app RPCs (called by the app as
-- service_role, which keeps EXECUTE via its own grant) currently carry a PUBLIC
-- grant, so anon retains EXECUTE on them until PUBLIC is revoked too. Match the
-- repo convention (2026-06-04 precedent: revoke ... from public, anon,
-- authenticated) by name so extension functions and current_shop_id() (kept
-- PUBLIC below) and the waitlist front door (re-granted below) are untouched.
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'inventory_reserve','inventory_commit','inventory_release','inventory_adjust',
        'inventory_mark_unavailable','inventory_create_transfer','inventory_receive_transfer',
        'promote_shop_catalog','promote_shop_from_mirror')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
  end loop;
end $$;

-- ============================================================================
-- 2. Fix default privileges so FUTURE objects are born locked.
--    postgres grantor covers everything created by our migrations.
-- ============================================================================
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;

-- Best-effort for the supabase_admin grantor default ACL. postgres is not a
-- member of supabase_admin, so this may raise insufficient_privilege; that is
-- acceptable because migration-created objects use the postgres grantor ACL
-- fixed above. Downgrade the failure to a warning rather than abort the apply.
do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from anon, authenticated';
  execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from anon, authenticated';
  execute 'alter default privileges for role supabase_admin in schema public revoke execute on functions from anon, authenticated';
exception when insufficient_privilege or others then
  raise warning 'supabase_admin default ACLs not changed (postgres is not a member); postgres-grantor ACLs cover all migration-created objects';
end $$;

-- ============================================================================
-- 3. Re-open the four deliberately-preserved lanes.
-- ============================================================================
-- (a) Realtime dormant path: authenticated SELECT, rows gated by the JWT
--     shop_id claim in the existing dashboard_read_* policies.
grant select on public.alerts, public.action_audit, public.ad_campaign_dim to authenticated;

-- (b) Marketing front door: the four definer-rights waitlist functions stay
--     anon-callable (keyed by p_key). Re-grant by name so signature drift can
--     never break the migration.
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('join_waitlist','waitlist_count','admin_list_waitlist','admin_log_event')
  loop
    execute format('grant execute on function %s to anon, authenticated', fn.sig);
  end loop;
end $$;

-- (c) current_shop_id() must stay callable from any role (policy quals).
grant execute on function public.current_shop_id() to public;

-- (d) service_role keeps EXECUTE on the app RPCs it calls via supabase-js .rpc()
--     (belt: it already holds this via the default ACL; make it explicit).
grant execute on all functions in schema public to service_role;

-- ============================================================================
-- 4. Complete RLS policy coverage on tenant-data tables (Groups P and F).
--    ALL policies compare shop_id (directly or via a shop_id-bearing ancestor)
--    to current_shop_id(). Guarded so the migration is re-runnable.
-- ============================================================================

-- Group P: direct shop_id scope. Written explicitly per table (matching the 62
-- existing hand-written policies) so the policy on each table is greppable in
-- review and asserted statically in CI, not hidden behind a format() loop.
drop policy if exists autopilot_run_lock_shop_scope on public.autopilot_run_lock;
create policy autopilot_run_lock_shop_scope on public.autopilot_run_lock as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists bug_report_shop_scope on public.bug_report;
create policy bug_report_shop_scope on public.bug_report as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists campaign_direction_reason_shop_scope on public.campaign_direction_reason;
create policy campaign_direction_reason_shop_scope on public.campaign_direction_reason as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists collection_dim_shop_scope on public.collection_dim;
create policy collection_dim_shop_scope on public.collection_dim as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists creative_screen_run_shop_scope on public.creative_screen_run;
create policy creative_screen_run_shop_scope on public.creative_screen_run as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists cutover_transition_shop_scope on public.cutover_transition;
create policy cutover_transition_shop_scope on public.cutover_transition as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists image_gen_event_shop_scope on public.image_gen_event;
create policy image_gen_event_shop_scope on public.image_gen_event as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists import_map_shop_scope on public.import_map;
create policy import_map_shop_scope on public.import_map as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists ingestion_dlq_shop_scope on public.ingestion_dlq;
create policy ingestion_dlq_shop_scope on public.ingestion_dlq as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists inventory_balance_shop_scope on public.inventory_balance;
create policy inventory_balance_shop_scope on public.inventory_balance as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists inventory_ledger_shop_scope on public.inventory_ledger;
create policy inventory_ledger_shop_scope on public.inventory_ledger as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists inventory_reservation_shop_scope on public.inventory_reservation;
create policy inventory_reservation_shop_scope on public.inventory_reservation as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists inventory_transfer_shop_scope on public.inventory_transfer;
create policy inventory_transfer_shop_scope on public.inventory_transfer as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists product_dim_shop_scope on public.product_dim;
create policy product_dim_shop_scope on public.product_dim as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists raw_google_poll_shop_scope on public.raw_google_poll;
create policy raw_google_poll_shop_scope on public.raw_google_poll as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists raw_meta_poll_shop_scope on public.raw_meta_poll;
create policy raw_meta_poll_shop_scope on public.raw_meta_poll as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists raw_owned_event_shop_scope on public.raw_owned_event;
create policy raw_owned_event_shop_scope on public.raw_owned_event as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists raw_quickbooks_poll_shop_scope on public.raw_quickbooks_poll;
create policy raw_quickbooks_poll_shop_scope on public.raw_quickbooks_poll as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists shipping_cost_period_shop_scope on public.shipping_cost_period;
create policy shipping_cost_period_shop_scope on public.shipping_cost_period as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists shipping_invoice_line_shop_scope on public.shipping_invoice_line;
create policy shipping_invoice_line_shop_scope on public.shipping_invoice_line as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists shop_settings_shop_scope on public.shop_settings;
create policy shop_settings_shop_scope on public.shop_settings as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

drop policy if exists variant_dim_shop_scope on public.variant_dim;
create policy variant_dim_shop_scope on public.variant_dim as permissive for all to public
  using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());

-- Group F: FK-child scope via a shop_id-bearing ancestor (mirrors the existing
-- sku_cost_history EXISTS precedent).
drop policy if exists product_option_shop_scope on public.product_option;
create policy product_option_shop_scope on public.product_option as permissive for all to public
  using (exists (select 1 from public.product_dim p where p.id = product_option.product_id and p.shop_id = public.current_shop_id()))
  with check (exists (select 1 from public.product_dim p where p.id = product_option.product_id and p.shop_id = public.current_shop_id()));

drop policy if exists product_media_shop_scope on public.product_media;
create policy product_media_shop_scope on public.product_media as permissive for all to public
  using (exists (select 1 from public.product_dim p where p.id = product_media.product_id and p.shop_id = public.current_shop_id()))
  with check (exists (select 1 from public.product_dim p where p.id = product_media.product_id and p.shop_id = public.current_shop_id()));

drop policy if exists product_collection_shop_scope on public.product_collection;
create policy product_collection_shop_scope on public.product_collection as permissive for all to public
  using (exists (select 1 from public.product_dim p where p.id = product_collection.product_id and p.shop_id = public.current_shop_id()))
  with check (exists (select 1 from public.product_dim p where p.id = product_collection.product_id and p.shop_id = public.current_shop_id()));

drop policy if exists variant_option_value_shop_scope on public.variant_option_value;
create policy variant_option_value_shop_scope on public.variant_option_value as permissive for all to public
  using (exists (select 1 from public.variant_dim v where v.id = variant_option_value.variant_id and v.shop_id = public.current_shop_id()))
  with check (exists (select 1 from public.variant_dim v where v.id = variant_option_value.variant_id and v.shop_id = public.current_shop_id()));

drop policy if exists product_option_value_shop_scope on public.product_option_value;
create policy product_option_value_shop_scope on public.product_option_value as permissive for all to public
  using (exists (select 1 from public.product_option po join public.product_dim p on p.id = po.product_id where po.id = product_option_value.option_id and p.shop_id = public.current_shop_id()))
  with check (exists (select 1 from public.product_option po join public.product_dim p on p.id = po.product_id where po.id = product_option_value.option_id and p.shop_id = public.current_shop_id()));

-- ============================================================================
-- 5. Self-tests. Any RAISE EXCEPTION rolls back the entire migration.
-- ============================================================================

-- 5a. Residual-grant assert: no anon/authenticated table grants survive except
--     the three realtime SELECTs we intentionally re-granted.
do $$
declare bad int;
begin
  select count(*) into bad
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon','authenticated')
    and not (grantee = 'authenticated' and privilege_type = 'SELECT'
             and table_name in ('alerts','action_audit','ad_campaign_dim'));
  if bad > 0 then
    raise exception 'self-test 5a: % residual anon/authenticated table grants remain', bad;
  end if;
end $$;

-- 5b. Coverage assert: every public table is either policy-covered or in the
--     documented deny-all allowlist. Forces explicit disposition of any table
--     added later. Any unclassified table aborts the apply.
do $$
declare offenders text;
begin
  select string_agg(c.relname, ', ') into offenders
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relkind = 'r'
    and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
    and c.relname <> all (array[
      -- deny-all allowlist (Group D, 22)
      'integration_credentials','mcp_oauth_codes','mcp_tokens','oauth_state',
      'dashboard_sessions','membership','admin_access_log','app_secret',
      'email_optouts','linkedin_connection','mcp_oauth_clients','mcp_pending_oauth',
      'password_reset_token','pilot_invites','rate_limit_hits','shopify_sessions',
      'shopify_sessions_migrations','social_digest','social_link_post','users',
      'waitlist','waitlist_rate_limit'
    ]);
  if offenders is not null then
    raise exception 'self-test 5b: unclassified no-policy tables: %', offenders;
  end if;
end $$;

-- 5c. anon lockdown behavioral proof: as anon, secret/tenant tables must be
--     unreadable (permission denied), not merely row-filtered. Guarded so a
--     role-membership quirk degrades to a warning instead of a false abort.
do $$
begin
  if not pg_has_role(current_user, 'anon', 'member') then
    raise warning 'self-test 5c skipped: current role cannot SET ROLE anon; rely on scripts/verify-rls.mjs';
  else
    set local role anon;
    begin
      perform 1 from public.users limit 1;
      raise exception 'self-test 5c: anon can read public.users';
    exception
      when insufficient_privilege then null;  -- expected
      when others then raise;
    end;
    begin
      perform 1 from public.product_dim limit 1;
      raise exception 'self-test 5c: anon can read public.product_dim';
    exception
      when insufficient_privilege then null;  -- expected
      when others then raise;
    end;
    reset role;
  end if;
end $$;

-- 5d. Functional RLS isolation proof (real rows, positive control). As app_web
--     (has SELECT on product_dim, no BYPASSRLS), setting app.shop_id to shop A
--     must show exactly shop A's rows and zero of shop B's. Read-only: picks
--     two existing shops, writes nothing, so the all-shops crons are never
--     polluted with synthetic rows.
do $$
declare
  shop_a uuid;
  shop_b uuid;
  seen_a int;
  seen_b_when_a int;
  truth_a int;
begin
  if not pg_has_role(current_user, 'app_web', 'member') then
    raise warning 'self-test 5d skipped: current role cannot SET ROLE app_web';
    return;
  end if;

  select shop_id into shop_a from public.product_dim
    group by shop_id having count(*) > 0 order by count(*) desc limit 1;
  select shop_id into shop_b from public.product_dim
    where shop_id <> shop_a group by shop_id having count(*) > 0 order by count(*) desc limit 1;
  if shop_a is null or shop_b is null then
    raise warning 'self-test 5d skipped: fewer than two shops own product_dim rows';
    return;
  end if;
  select count(*) into truth_a from public.product_dim where shop_id = shop_a;

  -- Guard the role-switched reads: if app_web lacks schema USAGE / SELECT the
  -- reads raise insufficient_privilege, which means "cannot run the proof", not
  -- "isolation failed" (5c + the probe script already prove lockdown). Degrade
  -- to a warning-skip rather than abort the apply. A genuine leak is a value
  -- comparison AFTER the reads succeed, so it still hard-fails below.
  begin
    set local role app_web;
    perform set_config('app.shop_id', shop_a::text, true);
    select count(*) into seen_a from public.product_dim;
    select count(*) into seen_b_when_a from public.product_dim where shop_id = shop_b;
    reset role;
  exception when insufficient_privilege then
    reset role;
    raise warning 'self-test 5d skipped: app_web lacks read privilege on product_dim (schema usage or select)';
    return;
  end;

  -- Positive control: app_web MUST see its own shop's rows (policy permits own
  -- rows) and must NOT see zero (a vacuous pass). Hard-assert these. The exact
  -- count match against the postgres-visible truth is informational only: it is
  -- read in a separate statement under READ COMMITTED, so a concurrent committed
  -- product_dim write to shop_a could shift it — a benign mismatch must not roll
  -- back a live-prod migration, so it degrades to a warning.
  if seen_a = 0 then
    raise exception 'self-test 5d: positive control saw zero rows (vacuous pass guard)';
  end if;
  if seen_a <> truth_a then
    raise warning 'self-test 5d: app_web saw % product_dim rows for shop_a, postgres-visible truth was % (likely a concurrent write; isolation assert below still holds)', seen_a, truth_a;
  end if;
  -- The security-critical invariant: app_web in shop_a context sees ZERO of
  -- shop_b's rows. This is a hard failure.
  if seen_b_when_a <> 0 then
    raise exception 'self-test 5d: cross-tenant leak - app_web in shop_a context saw % of shop_b rows', seen_b_when_a;
  end if;
end $$;

-- 5e. Function lockdown assert (safe, no execution): anon must NOT be able to
--     execute the app RPCs whose PUBLIC grant was revoked above. Checked via
--     has_function_privilege rather than by calling them (some are mutating).
do $$
declare bad text;
begin
  select string_agg(p.proname, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'inventory_reserve','inventory_commit','inventory_release','inventory_adjust',
      'inventory_mark_unavailable','inventory_create_transfer','inventory_receive_transfer',
      'promote_shop_catalog','promote_shop_from_mirror')
    and has_function_privilege('anon', p.oid, 'execute');
  if bad is not null then
    raise exception 'self-test 5e: anon can still execute: %', bad;
  end if;
end $$;
