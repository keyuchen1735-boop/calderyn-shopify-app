# Step 10 — Tenant Isolation Hardening (Postgres RLS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the anon/authenticated PostgREST attack surface and complete Postgres Row-Level Security policy coverage so a single forgotten `.eq('shop_id')` or a future `CREATE TABLE` cannot leak one merchant's data to another.

**Architecture:** One idempotent raw SQL migration under `supabase/migrations/`, applied to live prod via Supabase MCP `apply_migration` before the PR merges. The migration (1) revokes every `anon`/`authenticated`/`PUBLIC` grant on tables, sequences, and functions, keeping only four deliberately-preserved lanes; (2) fixes the `postgres` default privileges so future objects are born locked (best-effort for the `supabase_admin` grantor, which `postgres` cannot alter); (3) adds shop-scope RLS policies to every tenant-data table that lacked one, with an explicit deny-all carve-out for secret/auth-material and global tables; (4) proves isolation in-transaction with guarded self-tests that roll the whole migration back on any violation. A standalone Node probe script and a TypeScript manifest+content test guard the invariants. **Zero app-code behavior change is the target** — the app connects as `service_role` (BYPASSRLS) and the engine as `postgres` (BYPASSRLS), neither of which any statement here touches.

**Tech Stack:** PostgreSQL 15 (Supabase, project `ajgrmnvzxfxxlwrxcgnu`), Supabase MCP `apply_migration`/`execute_sql`, Node 20 ES modules (probe script), TypeScript + Vitest (manifest + content test).

## Global Constraints

- **Migration style:** lowercase SQL; leading comment block stating the threat model and *why this breaks nothing*; timestamped filename `20260702120000_tenant_isolation_hardening.sql` (after the current latest `20260702000000_ship_cost_batch_apply.sql`).
- **Never break the bypass roles:** `service_role` (app) and `postgres` (engine) have `rolbypassrls=true` and must keep full access. No statement may revoke from `service_role`, `postgres`, `app_web`, or `app_engine`.
- **Four preserved lanes (verified live 2026-07-01):** (a) realtime dormant path needs `authenticated` SELECT on `alerts`, `action_audit`, `ad_campaign_dim`; (b) marketing front door needs `anon`/`authenticated` EXECUTE on `join_waitlist`, `waitlist_count`, `admin_list_waitlist`, `admin_log_event`; (c) `current_shop_id()` must keep PUBLIC EXECUTE (policy quals call it); (d) `set_current_shop_id(uuid)` must stay `postgres`+`service_role` only (2026-06-04 breach fix).
- **Ground-truth facts (queried live 2026-07-01, do not re-derive):** 111 public tables, all RLS-enabled; 62 have policies, 49 do not. All 686 existing `anon`/`authenticated` table grants and all 24 function grants have `grantor=postgres` (fully revocable by `postgres`). `postgres` is NOT superuser but IS a member of `anon` and `app_web` (so `SET ROLE` self-tests run first-pass). `app_web` already holds SELECT on `product_dim`. `postgres` is NOT a member of `supabase_admin` (so `alter default privileges for role supabase_admin` fails → must be exception-guarded). Two default-ACL grantors exist (`postgres`, `supabase_admin`); migration-created objects inherit the `postgres` grantor ACL.
- **No `CREATE OR REPLACE VIEW`** (append-only + prod column-order drift). Views need no redefinition here — 19/20 already `security_invoker`; the migration only *asserts* this, it does not change views.
- **Do not touch `tests/engine/schema/`** — curated partial mirror owned by another lane; grants/policy migrations are not mirrored there (its CI parity DB creates roles itself).
- **No em/en dashes** in any merchant-facing copy (none here; infra PR).
- **Dashboard parity:** exempt — this is pure DB infra with zero user-visible surface. State this explicitly in the PR.
- **Apply order:** migration goes to prod via MCP `apply_migration` BEFORE merge; smoke immediately after; then PR.

---

## Disposition of the 49 no-policy tables (the classification oracle)

This is the single source of truth. Total must equal 49. Three disjoint groups:

**Group P — shop-scope policy `using (shop_id = current_shop_id())` (22 tenant-data tables with `shop_id`):**
`autopilot_run_lock, bug_report, campaign_direction_reason, collection_dim, creative_screen_run, cutover_transition, image_gen_event, import_map, ingestion_dlq, inventory_balance, inventory_ledger, inventory_reservation, inventory_transfer, product_dim, raw_google_poll, raw_meta_poll, raw_owned_event, raw_quickbooks_poll, shipping_cost_period, shipping_invoice_line, shop_settings, variant_dim`

**Group F — FK-child policy `using (exists (select 1 from <parent> where <parent>.id = <fk> and <parent>.shop_id = current_shop_id()))` (5 catalog children, no `shop_id`, mirrors the existing `sku_cost_history` precedent):**
- `product_option` → parent `product_dim` on `product_id`
- `product_option_value` → parent `product_option` on `option_id` (grandparent `product_dim` reached transitively; policy joins one level to `product_option`, which is itself now policy-covered — but RLS on a parent does NOT cascade into a subquery, so the EXISTS must reach a `shop_id`-bearing ancestor: join `product_option` → `product_dim`)
- `variant_option_value` → parent `variant_dim` on `variant_id`
- `product_media` → parent `product_dim` on `product_id`
- `product_collection` → parent `product_dim` on `product_id`

**Group D — DENY-ALL, stay no-policy (22 tables: 6 with `shop_id` that are secret/auth material + 16 global/auth/marketing with no `shop_id`):**
- Secret/auth with `shop_id` (6): `integration_credentials, mcp_oauth_codes, mcp_tokens, oauth_state, dashboard_sessions, membership`
- Global/auth/marketing, no `shop_id` (16): `admin_access_log, app_secret, email_optouts, linkedin_connection, mcp_oauth_clients, mcp_pending_oauth, password_reset_token, pilot_invites, rate_limit_hits, shopify_sessions, shopify_sessions_migrations, social_digest, social_link_post, users, waitlist, waitlist_rate_limit`

Rationale for Group D: these hold OAuth tokens, bearer tokens, CSRF state, session tokens, password-reset tokens, user↔shop links (read *before* tenant context resolves), Shopify session storage, rate-limit counters, and marketing-site rows. They are reached only via `service_role`; a `current_shop_id()` policy would be either circular (`membership` resolves the shop) or pointless (a secret should never be tenant-role-readable *at all*). Deny-all + no grant is the strictly stronger posture, so we leave them policy-free by design.

**Coverage identity:** 22 (P) + 5 (F) + 22 (D) = 49. ✓ Every no-policy table is now explicitly dispositioned. The migration's coverage self-test enforces this against the live catalog.

---

## File Structure

- **Create:** `supabase/migrations/20260702120000_tenant_isolation_hardening.sql` — the entire hardening migration (revokes, default-ACL fix, policies, function hygiene, preserved-lane re-grants, self-tests). One file; it is one atomic change.
- **Create:** `app/lib/security/tenant-tables.ts` — the disposition manifest (Group P/F/D as exported const arrays) that is the test oracle and human-readable documentation.
- **Create:** `app/lib/security/__tests__/tenant-tables.test.ts` — Vitest test asserting the manifest is internally consistent (disjoint, sums to 49) and that the migration file's SQL matches the manifest (a policy per P/F table, none for D tables, all four preserved lanes present, no view creation / no security-definer).
- **Create:** `scripts/verify-rls.mjs` — standalone Node probe run post-apply against prod: hits PostgREST with the real `anon` key and asserts 401/permission-denied (not 200) on locked tables, `set_current_shop_id` rpc is not anon-callable (breach regression), `waitlist_count` rpc still returns 200 (liveness).
- **Modify:** `.env.example` — add the two probe env vars (`CALDERYN_PROBE_SUPABASE_URL`, `CALDERYN_PROBE_ANON_KEY`) with comments; note they are for the manual probe only.
- **Do NOT touch:** any `app/**` runtime code, `tests/engine/schema/**`, any view.

---

### Task 1: Disposition manifest + failing manifest-consistency test

**Files:**
- Create: `app/lib/security/tenant-tables.ts`
- Test: `app/lib/security/__tests__/tenant-tables.test.ts`

**Interfaces:**
- Produces: `export const SHOP_SCOPE_POLICY_TABLES: string[]` (Group P, 22), `export const FK_CHILD_POLICY_TABLES: { table: string; parent: string; fk: string; parentKey: string }[]` (Group F, 5), `export const DENY_ALL_TABLES: string[]` (Group D, 22), `export const NO_POLICY_TABLE_COUNT = 49`.

- [ ] **Step 1: Write the failing test** (`app/lib/security/__tests__/tenant-tables.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import {
  SHOP_SCOPE_POLICY_TABLES,
  FK_CHILD_POLICY_TABLES,
  DENY_ALL_TABLES,
  NO_POLICY_TABLE_COUNT,
} from "../tenant-tables";

describe("tenant-tables manifest", () => {
  it("the three dispositions are disjoint", () => {
    const fk = FK_CHILD_POLICY_TABLES.map((f) => f.table);
    const all = [...SHOP_SCOPE_POLICY_TABLES, ...fk, ...DENY_ALL_TABLES];
    expect(new Set(all).size).toBe(all.length);
  });

  it("covers exactly the 49 no-policy tables", () => {
    const total =
      SHOP_SCOPE_POLICY_TABLES.length +
      FK_CHILD_POLICY_TABLES.length +
      DENY_ALL_TABLES.length;
    expect(total).toBe(NO_POLICY_TABLE_COUNT);
    expect(NO_POLICY_TABLE_COUNT).toBe(49);
  });

  it("group sizes match the live census (22 / 5 / 22)", () => {
    expect(SHOP_SCOPE_POLICY_TABLES).toHaveLength(22);
    expect(FK_CHILD_POLICY_TABLES).toHaveLength(5);
    expect(DENY_ALL_TABLES).toHaveLength(22);
  });

  it("every FK-child names a shop_id-bearing ancestor", () => {
    for (const f of FK_CHILD_POLICY_TABLES) {
      expect(f.parent).toBeTruthy();
      expect(f.fk).toBeTruthy();
      expect(f.parentKey).toBe("id");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from worktree root): `npx vitest run app/lib/security/__tests__/tenant-tables.test.ts`
Expected: FAIL — cannot resolve `../tenant-tables`.

- [ ] **Step 3: Write the manifest** (`app/lib/security/tenant-tables.ts`)

```ts
// Tenant-isolation disposition manifest for Step 10 RLS hardening.
//
// Single source of truth for which of the 49 previously-policy-free public
// tables receive a shop-scope RLS policy versus stay deny-all by design.
// This mirrors, and is asserted against, supabase/migrations/
// 20260702120000_tenant_isolation_hardening.sql. Any table added to the
// database later must be classified here (and in that migration's coverage
// self-test) or the security posture drifts silently.

/** Group P: tenant-data tables that get `using (shop_id = current_shop_id())`. */
export const SHOP_SCOPE_POLICY_TABLES: string[] = [
  "autopilot_run_lock",
  "bug_report",
  "campaign_direction_reason",
  "collection_dim",
  "creative_screen_run",
  "cutover_transition",
  "image_gen_event",
  "import_map",
  "ingestion_dlq",
  "inventory_balance",
  "inventory_ledger",
  "inventory_reservation",
  "inventory_transfer",
  "product_dim",
  "raw_google_poll",
  "raw_meta_poll",
  "raw_owned_event",
  "raw_quickbooks_poll",
  "shipping_cost_period",
  "shipping_invoice_line",
  "shop_settings",
  "variant_dim",
];

/** Group F: catalog children scoped via a shop_id-bearing ancestor. */
export const FK_CHILD_POLICY_TABLES: {
  table: string;
  parent: string;
  fk: string;
  parentKey: string;
}[] = [
  { table: "product_option", parent: "product_dim", fk: "product_id", parentKey: "id" },
  { table: "product_media", parent: "product_dim", fk: "product_id", parentKey: "id" },
  { table: "product_collection", parent: "product_dim", fk: "product_id", parentKey: "id" },
  { table: "variant_option_value", parent: "variant_dim", fk: "variant_id", parentKey: "id" },
  // product_option_value reaches shop_id via product_option -> product_dim.
  { table: "product_option_value", parent: "product_option", fk: "option_id", parentKey: "id" },
];

/** Group D: secret/auth-material and global tables that stay deny-all (no policy). */
export const DENY_ALL_TABLES: string[] = [
  // secret/auth with shop_id
  "integration_credentials",
  "mcp_oauth_codes",
  "mcp_tokens",
  "oauth_state",
  "dashboard_sessions",
  "membership",
  // global / auth / marketing, no shop_id
  "admin_access_log",
  "app_secret",
  "email_optouts",
  "linkedin_connection",
  "mcp_oauth_clients",
  "mcp_pending_oauth",
  "password_reset_token",
  "pilot_invites",
  "rate_limit_hits",
  "shopify_sessions",
  "shopify_sessions_migrations",
  "social_digest",
  "social_link_post",
  "users",
  "waitlist",
  "waitlist_rate_limit",
];

export const NO_POLICY_TABLE_COUNT = 49;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/security/__tests__/tenant-tables.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/security/tenant-tables.ts app/lib/security/__tests__/tenant-tables.test.ts
git commit -F <msg-file>   # "security/rls: tenant-table disposition manifest + consistency test"
```

---

### Task 2: The hardening migration

**Files:**
- Create: `supabase/migrations/20260702120000_tenant_isolation_hardening.sql`
- Test: extends `app/lib/security/__tests__/tenant-tables.test.ts` (content assertions against the SQL file)

**Interfaces:**
- Consumes: the manifest arrays from Task 1 (for the content test only; the SQL itself is standalone).
- Produces: the applied migration (policies + revokes) — no code depends on it at build time.

- [ ] **Step 1: Write the failing content test** (append to `tenant-tables.test.ts`)

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MIGRATION = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../supabase/migrations/20260702120000_tenant_isolation_hardening.sql",
  ),
  "utf8",
).toLowerCase();

describe("tenant_isolation_hardening migration content", () => {
  it("creates a policy for every shop-scope and FK-child table", () => {
    for (const t of SHOP_SCOPE_POLICY_TABLES) {
      expect(MIGRATION).toMatch(new RegExp(`create policy[^;]+on public\\.${t}\\b`));
    }
    for (const f of FK_CHILD_POLICY_TABLES) {
      expect(MIGRATION).toMatch(new RegExp(`create policy[^;]+on public\\.${f.table}\\b`));
    }
  });

  it("creates no policy for any deny-all table", () => {
    for (const t of DENY_ALL_TABLES) {
      expect(MIGRATION).not.toMatch(new RegExp(`create policy[^;]+on public\\.${t}\\b`));
    }
  });

  it("revokes the anon/authenticated relation, sequence, and function surface", () => {
    expect(MIGRATION).toMatch(/revoke all on all tables in schema public from anon, authenticated/);
    expect(MIGRATION).toMatch(/revoke all on all sequences in schema public from anon, authenticated/);
    expect(MIGRATION).toMatch(/revoke execute on all functions in schema public from anon, authenticated/);
  });

  it("fixes the postgres default privileges (tables, sequences, functions)", () => {
    expect(MIGRATION).toMatch(/alter default privileges for role postgres in schema public\s+revoke all on tables from anon, authenticated/);
    expect(MIGRATION).toMatch(/alter default privileges for role postgres in schema public\s+revoke .*on sequences from anon, authenticated/);
    expect(MIGRATION).toMatch(/alter default privileges for role postgres in schema public\s+revoke execute on functions from anon, authenticated/);
  });

  it("preserves the four designed lanes", () => {
    // (a) realtime SELECT re-grant
    expect(MIGRATION).toMatch(/grant select on[^;]*alerts[^;]*to authenticated/);
    // (b) waitlist definer fns re-granted to anon
    expect(MIGRATION).toMatch(/join_waitlist/);
    expect(MIGRATION).toMatch(/waitlist_count/);
    // (c) current_shop_id keeps public execute
    expect(MIGRATION).toMatch(/grant execute on function public\.current_shop_id\(\) to public/);
    // (d) set_current_shop_id is NOT re-granted to anon anywhere
    expect(MIGRATION).not.toMatch(/grant execute on function public\.set_current_shop_id[^;]*to[^;]*anon/);
  });

  it("does not create or replace any view and adds no security-definer object", () => {
    expect(MIGRATION).not.toMatch(/create or replace view/);
    expect(MIGRATION).not.toMatch(/create view/);
    expect(MIGRATION).not.toMatch(/security definer/);
  });

  it("carries in-transaction self-tests", () => {
    expect(MIGRATION).toMatch(/set local role anon|set role anon/);
    expect(MIGRATION).toMatch(/set local role app_web|set role app_web/);
    expect(MIGRATION).toMatch(/raise exception/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/security/__tests__/tenant-tables.test.ts`
Expected: FAIL — migration file does not exist (ENOENT).

- [ ] **Step 3: Write the migration** (`supabase/migrations/20260702120000_tenant_isolation_hardening.sql`)

Write the full SQL below. Section order matters (revokes and default-ACL first so the coverage/behavior self-tests at the end observe the final state).

```sql
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

-- (b) Marketing front door: the four SECURITY DEFINER waitlist functions stay
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

-- Group P: direct shop_id scope.
do $$
declare t text;
begin
  foreach t in array array[
    'autopilot_run_lock','bug_report','campaign_direction_reason','collection_dim',
    'creative_screen_run','cutover_transition','image_gen_event','import_map',
    'ingestion_dlq','inventory_balance','inventory_ledger','inventory_reservation',
    'inventory_transfer','product_dim','raw_google_poll','raw_meta_poll',
    'raw_owned_event','raw_quickbooks_poll','shipping_cost_period',
    'shipping_invoice_line','shop_settings','variant_dim'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_shop_scope', t);
    execute format(
      'create policy %I on public.%I as permissive for all to public using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id())',
      t || '_shop_scope', t);
  end loop;
end $$;

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
--     must show exactly shop A's rows and zero of shop B's, and vice versa.
--     Read-only: picks two existing shops, writes nothing, so the all-shops
--     crons are never polluted with synthetic rows.
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

  select shop_id into shop_a from public.product_dim group by shop_id having count(*) > 0 order by count(*) desc limit 1;
  select shop_id into shop_b from public.product_dim where shop_id <> shop_a group by shop_id having count(*) > 0 order by count(*) desc limit 1;
  if shop_a is null or shop_b is null then
    raise warning 'self-test 5d skipped: fewer than two shops own product_dim rows';
    return;
  end if;
  select count(*) into truth_a from public.product_dim where shop_id = shop_a;  -- postgres-visible ground truth

  set local role app_web;
  perform set_config('app.shop_id', shop_a::text, true);
  select count(*) into seen_a from public.product_dim;
  select count(*) into seen_b_when_a from public.product_dim where shop_id = shop_b;
  reset role;

  if seen_a <> truth_a then
    raise exception 'self-test 5d: app_web with shop_a context saw % product_dim rows, expected % (positive control failed)', seen_a, truth_a;
  end if;
  if seen_a = 0 then
    raise exception 'self-test 5d: positive control saw zero rows (vacuous pass guard)';
  end if;
  if seen_b_when_a <> 0 then
    raise exception 'self-test 5d: cross-tenant leak — app_web in shop_a context saw % of shop_b rows', seen_b_when_a;
  end if;
end $$;
```

> **Implementer notes on the SQL:**
> - `set_config('app.shop_id', ..., true)` uses `is_local=true` so the GUC is transaction-scoped; combined with `set local role`, both reset at the block/transaction boundary.
> - The `exception when insufficient_privilege or others then` in section 2 is intentional breadth — the `supabase_admin` alter can fail several ways on a managed instance; any failure there is non-fatal by design.
> - `as permissive for all to public` matches the pattern of the 62 existing policies exactly (roles `{public}`, one ALL policy per table).
> - Do NOT add policies to the three realtime tables or reference `auth.jwt()` in any self-test — custom roles lack USAGE on schema `auth` and would raise permission-denied rather than filter.

- [ ] **Step 4: Run the content test to verify it passes**

Run: `npx vitest run app/lib/security/__tests__/tenant-tables.test.ts`
Expected: PASS (all manifest + content assertions).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260702120000_tenant_isolation_hardening.sql app/lib/security/__tests__/tenant-tables.test.ts
git commit -F <msg-file>   # "supabase: tenant isolation RLS hardening migration + content guard"
```

---

### Task 3: Standalone prod probe script

**Files:**
- Create: `scripts/verify-rls.mjs`
- Modify: `.env.example` (add `CALDERYN_PROBE_SUPABASE_URL`, `CALDERYN_PROBE_ANON_KEY`)

**Interfaces:**
- Consumes: `process.env.CALDERYN_PROBE_SUPABASE_URL`, `process.env.CALDERYN_PROBE_ANON_KEY`.
- Produces: exit 0 on all-pass, exit 1 with a printed report on any failure. No imports from app code.

- [ ] **Step 1: Write the probe script** (`scripts/verify-rls.mjs`)

```js
#!/usr/bin/env node
// Post-apply isolation probe for the tenant-isolation-hardening migration.
// Hits PostgREST as the anon role and asserts the attack surface is closed:
// locked tables return 401 (permission denied), not 200; the breach-fix RPC is
// not anon-callable; the waitlist front door still works. Run against prod
// after apply_migration. Reads no secrets from source; both values come from
// the environment (see .env.example).
//
//   CALDERYN_PROBE_SUPABASE_URL=... CALDERYN_PROBE_ANON_KEY=... node scripts/verify-rls.mjs

const url = process.env.CALDERYN_PROBE_SUPABASE_URL;
const key = process.env.CALDERYN_PROBE_ANON_KEY;
if (!url || !key) {
  console.error("Set CALDERYN_PROBE_SUPABASE_URL and CALDERYN_PROBE_ANON_KEY.");
  process.exit(2);
}

const headers = { apikey: key, Authorization: `Bearer ${key}` };
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function getStatus(pathAndQuery) {
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, { headers });
  return res.status;
}

// Locked tables: anon has no grant, so PostgREST returns 401 (permission
// denied), NOT 200 with an empty array. 200 would mean a grant leaked back.
const LOCKED = ["users?select=id", "product_dim?select=id", "integration_credentials?select=id", "order_fact?select=id"];
for (const t of LOCKED) {
  const s = await getStatus(t);
  record(`anon locked out of ${t.split("?")[0]}`, s === 401 || s === 403, `HTTP ${s}`);
}

// Breach regression: set_current_shop_id must not be anon-callable.
{
  const res = await fetch(`${url}/rest/v1/rpc/set_current_shop_id`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ p_shop_id: "00000000-0000-0000-0000-000000000000" }),
  });
  record("set_current_shop_id not anon-callable", res.status === 404 || res.status === 401 || res.status === 403, `HTTP ${res.status}`);
}

// Liveness: the marketing waitlist front door must still answer for anon.
{
  const res = await fetch(`${url}/rest/v1/rpc/waitlist_count`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: "{}",
  });
  record("waitlist_count still anon-callable", res.status === 200, `HTTP ${res.status}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);
```

- [ ] **Step 2: Add the env vars** (`.env.example`)

Append near the Supabase block:

```
# RLS probe (manual, scripts/verify-rls.mjs) — the project anon/publishable key.
# Used only to verify anon is locked out after the tenant-isolation migration.
CALDERYN_PROBE_SUPABASE_URL=
CALDERYN_PROBE_ANON_KEY=
```

- [ ] **Step 3: Lint the script** (no test — it is an integration probe)

Run: `npx eslint scripts/verify-rls.mjs --max-warnings=0`
Expected: exit 0. (If eslint flags top-level await, confirm the repo's eslint targets ES2022+; otherwise wrap the body in an async IIFE.)

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-rls.mjs .env.example
git commit -F <msg-file>   # "scripts: anon PostgREST isolation probe for RLS hardening"
```

---

### Task 4: Apply to prod, smoke, and full gate

- [ ] **Step 1: Apply the migration to prod** via Supabase MCP `apply_migration` (name `tenant_isolation_hardening`, the file body). This runs the in-transaction self-tests; a failure aborts and rolls back cleanly. If 5a/5b abort, fix the migration and re-run (idempotent). If 5c/5d warn-skip, proceed — the probe script is the fallback proof.

- [ ] **Step 2: Smoke the objects** via `execute_sql`: (a) count policies now present on the 27 policy tables (expect 27 new); (b) re-run the coverage query (expect zero unclassified); (c) confirm anon/authenticated residual table grants = the 3 realtime SELECTs only; (d) confirm `current_shop_id` still has PUBLIC execute and `set_current_shop_id` does not grant anon.

- [ ] **Step 3: Run the probe** against prod: fetch the anon key via MCP `get_publishable_keys`, export the two env vars, `node scripts/verify-rls.mjs`. Expect all PASS.

- [ ] **Step 4: App liveness** — hit `/cron/ingest` with `Authorization: Bearer $CRON_SECRET` (expect 200, clean summary) and load the dashboard (service-role path still reads). Both prove the bypass roles are unaffected.

- [ ] **Step 5: Pre-commit gate** (paste evidence, in order): `/code-review` (resolve blockers) → `git diff --check` → `npm run typecheck` → `npm run lint` (touched files `--max-warnings=0`) → `npx vitest run` (full suite) → `npm run build` → `npx prisma validate` (schema unchanged, sanity) → migration-diff sanity via MCP `list_migrations`.

- [ ] **Step 6: Push, open PR, merge** via `gh pr merge --admin --merge` once the gate is green. PR body: threat model, why nothing breaks, the four preserved lanes, the deny-all rationale, dashboard-parity exemption note, and the platform-pivot two-part progress report.

---

## Self-Review

**Spec coverage (#12):** ENABLE RLS + shop_id policies on shop_id tables → Tasks 1–2 (Groups P/F; RLS already enabled, policies were the gap). Views security_invoker → asserted, already true (no change needed; note in PR). Request-scoped tenant context for reads → **explicitly descoped** (the TS app-role switch is the "larger architecture change" the spec itself flags; this PR lands the structural insurance and the `app_web` proof that the context mechanism works, leaving the connection-role swap to a future activation PR). Audited service-role ETL lane → **descoped/no-op**: the cron ETL already runs as `service_role`/`postgres` (BYPASSRLS) and is unaffected; no new lane is needed because policies do not constrain bypass roles. Test harness proving wrong-tenant returns zero rows → Task 2 self-test 5d (functional) + Task 3 probe (anon). Belt-and-suspenders `.eq('shop_id')` audit → **descoped**: 283 call-sites stay as-is (the app-level guard is retained by not changing app code); a full audit is out of scope for one PR and the coverage/isolation tests are the higher-value proof. All descopes are stated in the PR body.

**Placeholder scan:** none — every SQL section, test, and script is complete literal content.

**Type/name consistency:** manifest arrays (Task 1) ↔ migration policy loop + coverage allowlist (Task 2) ↔ content-test regexes (Task 2 Step 1) all reference the same table names; group sizes 22/5/22 are asserted in three places.
