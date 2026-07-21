import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/202607200004_storefront_bundle_cart_lines.sql", "utf8");

describe("atomic bundle cart migration", () => {
  it("validates the complete bounded input before any line mutation and keeps the legacy RPC", () => {
    expect(sql).toContain("create or replace function public.cart_add_lines_atomic");
    expect(sql.indexOf("for v_line in select value from jsonb_array_elements(p_lines) loop"))
      .toBeLessThan(sql.indexOf("v_added := public.cart_add_line_atomic"));
    expect(sql).not.toContain("drop function public.cart_add_line_atomic");
    expect(sql).toContain("grant execute on function public.cart_add_lines_atomic(uuid,uuid,jsonb) to service_role");
  });

  it("preflights existing and incoming currencies while locked before mutation", () => {
    const lock = sql.indexOf("for update");
    const currencyPreflight = sql.indexOf("bundle currency");
    const mutation = sql.indexOf("v_added := public.cart_add_line_atomic");
    expect(lock).toBeGreaterThan(-1);
    expect(currencyPreflight).toBeGreaterThan(lock);
    expect(currencyPreflight).toBeLessThan(mutation);
    expect(sql).toMatch(/from public\.cart_line[\s\S]*?shop_id = p_shop_id[\s\S]*?cart_id = p_cart_id/);
  });

  it("locks existing cart lines after the parent cart and before every preflight", () => {
    const parentLock = sql.indexOf("from public.cart where shop_id = p_shop_id");
    const lineLockMatch = /perform 1\s+from public\.cart_line cl\s+where cl\.shop_id = p_shop_id and cl\.cart_id = p_cart_id\s+for update;/.exec(sql);
    const lineLock = lineLockMatch?.index ?? -1;
    const currencyPreflight = sql.indexOf("select count(distinct lower(currency))");
    const quantityPreflight = sql.indexOf("resulting cart line quantity exceeds 999");
    const mutation = sql.indexOf("v_added := public.cart_add_line_atomic");
    expect(lineLock).toBeGreaterThan(parentLock);
    expect(lineLock).toBeLessThan(currencyPreflight);
    expect(currencyPreflight).toBeLessThan(quantityPreflight);
    expect(quantityPreflight).toBeLessThan(mutation);
  });

  it("preflights every resulting canonical quantity before mutation", () => {
    const quantityPreflight = sql.indexOf("resulting cart line quantity exceeds 999");
    const mutation = sql.indexOf("v_added := public.cart_add_line_atomic");
    expect(quantityPreflight).toBeGreaterThan(sql.indexOf("for update"));
    expect(quantityPreflight).toBeLessThan(mutation);
    expect(sql).toMatch(/cl\.quantity \+ \(v_line->>'quantity'\)::integer > 999/);
  });
});
