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
});
