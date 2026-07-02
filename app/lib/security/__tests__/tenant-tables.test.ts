import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
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
    expect(MIGRATION).toMatch(
      /alter default privileges for role postgres in schema public\s+revoke all on tables from anon, authenticated/,
    );
    expect(MIGRATION).toMatch(
      /alter default privileges for role postgres in schema public\s+revoke .*on sequences from anon, authenticated/,
    );
    expect(MIGRATION).toMatch(
      /alter default privileges for role postgres in schema public\s+revoke execute on functions from anon, authenticated/,
    );
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

  it("revokes PUBLIC execute on the app RPCs (not just anon/authenticated)", () => {
    // Postgres grants function EXECUTE to PUBLIC by default; revoking only
    // anon/authenticated leaves anon able to execute via PUBLIC membership.
    expect(MIGRATION).toMatch(/revoke all on function[^;]+from public, anon, authenticated/);
    expect(MIGRATION).toMatch(/promote_shop_from_mirror/);
    expect(MIGRATION).toMatch(/inventory_reserve/);
  });

  it("carries in-transaction self-tests", () => {
    expect(MIGRATION).toMatch(/set local role anon|set role anon/);
    expect(MIGRATION).toMatch(/set local role app_web|set role app_web/);
    expect(MIGRATION).toMatch(/has_function_privilege\('anon'/);
    expect(MIGRATION).toMatch(/raise exception/);
  });
});
