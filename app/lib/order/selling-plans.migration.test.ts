import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/202607200003_storefront_selling_plans.sql", "utf8");

describe("trusted selling-plan migration", () => {
  it("persists merchant-owned groups, plans, and variant eligibility", () => {
    expect(sql).toContain("create table public.selling_plan_group");
    expect(sql).toContain("create table public.selling_plan");
    expect(sql).toContain("create table public.variant_selling_plan");
    expect(sql).toContain("primary key (shop_id, variant_id, selling_plan_id)");
  });

  it("keeps one-time and eligible plan lines as distinct canonical identities", () => {
    expect(sql).toContain("unique (shop_id, cart_id, variant_id, personalization_hash, selling_plan_id)");
    expect(sql).toContain("selling plan is not eligible for variant");
    expect(sql).toContain("coalesce(v_plan_price, p_unit_price_cents)");
  });

  it("snapshots plan presentation onto orders and retains rolling RPC signatures", () => {
    expect(sql).toMatch(/alter table public\.order_line[\s\S]*selling_plan_id text[\s\S]*selling_plan_name text[\s\S]*selling_plan_cadence text/);
    expect(sql).toMatch(/p_personalization jsonb, p_selling_plan_id text/);
    expect(sql).toMatch(/p_title_snapshot text, p_personalization jsonb\s*\) returns jsonb/);
  });
});
