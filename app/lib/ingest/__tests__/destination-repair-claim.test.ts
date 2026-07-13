import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../supabase/migrations/20260713160000_order_destination_repair.sql",
  ),
  "utf8",
).toLowerCase();

describe("order destination repair claim migration", () => {
  it("atomically claims bounded ready/live work with locked-skip concurrency", () => {
    expect(MIGRATION).toMatch(
      /create or replace function public\.claim_order_destination_repairs/,
    );
    expect(MIGRATION).toMatch(/for update of si skip locked/);
    expect(MIGRATION).toMatch(/update public\.shop_integrations/);
    expect(MIGRATION).toMatch(
      /destination_repair_attempted_at\s*=\s*(?:now|clock_timestamp)\(\)/,
    );
    expect(MIGRATION).toMatch(/limit\s+greatest\(/);
    expect(MIGRATION).toMatch(/sync_status\s+in\s*\('ready',\s*'live'\)/);
    expect(MIGRATION).toMatch(/destination_repair_completed_at is null/);
  });

  it("leases attempts and orders interrupted work fairly", () => {
    expect(MIGRATION).toMatch(
      /destination_repair_attempted_at is null[^;]+interval '30 minutes'/s,
    );
    expect(MIGRATION).toMatch(
      /order by[^;]+destination_repair_attempted_at asc nulls first/s,
    );
    expect(MIGRATION).toMatch(/claimed_at/);
  });

  it("returns only tenant-fenced shop claims", () => {
    expect(MIGRATION).toMatch(
      /returns table\s*\(\s*shop_id uuid,\s*shop_domain text,\s*claimed_at timestamptz\s*\)/,
    );
    expect(MIGRATION).toMatch(/join public\.shops s on s\.id = si\.shop_id/);
    expect(MIGRATION).toMatch(/where si\.kind = 'shopify'/);
  });

  it("is a hardened service-role-only definer RPC", () => {
    expect(MIGRATION).toMatch(/security definer\s+set search_path = ''/);
    expect(MIGRATION).toMatch(
      /revoke all on function public\.claim_order_destination_repairs\(integer\) from public/,
    );
    expect(MIGRATION).toMatch(
      /revoke execute on function public\.claim_order_destination_repairs\(integer\) from anon, authenticated/,
    );
    expect(MIGRATION).toMatch(
      /grant execute on function public\.claim_order_destination_repairs\(integer\) to service_role/,
    );
  });
});
