import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/202607200005_selling_plan_ingestion.sql", "utf8");

describe("selling-plan snapshot migration", () => {
  it("adds provider identities and one atomic shop-scoped replacement function", () => {
    expect(sql).toMatch(/selling_plan_group[\s\S]*provider[\s\S]*external_id/);
    expect(sql).toMatch(/selling_plan[\s\S]*provider[\s\S]*external_id/);
    expect(sql).toContain("create or replace function public.replace_selling_plan_snapshot");
    expect(sql).toContain("where v.shop_id = p_shop_id and v.external_id =");
  });

  it("upserts before deleting stale provider rows and grants only service role", () => {
    expect(sql.indexOf("insert into public.selling_plan_group")).toBeLessThan(sql.indexOf("delete from public.variant_selling_plan"));
    expect(sql.indexOf("insert into public.selling_plan")).toBeLessThan(sql.indexOf("delete from public.selling_plan sp"));
    expect(sql).toMatch(/delete from public\.selling_plan sp[\s\S]*sp\.shop_id = p_shop_id and sp\.provider = p_provider/);
    expect(sql).toMatch(/delete from public\.selling_plan_group sg[\s\S]*sg\.shop_id = p_shop_id and sg\.provider = p_provider/);
    expect(sql).toContain("revoke all on function public.replace_selling_plan_snapshot");
    expect(sql).toContain("grant execute on function public.replace_selling_plan_snapshot");
  });

  it("validates every reference before writes and relies on function rollback after writes", () => {
    const firstInsert = sql.indexOf("insert into public.selling_plan_group");
    expect(sql.indexOf("selling-plan snapshot reference is unresolved")).toBeLessThan(firstInsert);
    expect(sql.indexOf("selling-plan variant mapping failed")).toBeLessThan(firstInsert);
    expect(sql).toContain("language plpgsql security definer");
    expect(sql).not.toMatch(/exception[\s\S]*commit/i);
  });

  it("removes only stale rows from the requested shop and provider snapshot", () => {
    const eligibilityDelete = sql.slice(sql.indexOf("delete from public.variant_selling_plan"), sql.indexOf("select count(*) into c_groups"));
    expect(eligibilityDelete).toContain("vsp.shop_id = p_shop_id");
    expect(eligibilityDelete).toContain("sp.shop_id = p_shop_id");
    expect(eligibilityDelete).toContain("sp.provider = p_provider");
    expect(eligibilityDelete).toContain("not exists");
    expect(sql).toContain("pg_advisory_xact_lock");
  });
});
