import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20260720194917_product_facts.sql", "utf8");

describe("product facts migration", () => {
  it("enforces tenant ownership, a bounded closed catalog, types, units, and safe URLs", () => {
    expect(sql).toContain("foreign key (shop_id, product_id) references public.product_dim(shop_id, id)");
    expect(sql).toContain("unique (shop_id, product_id, position)");
    expect(sql.match(/unique .*product_fact.*dimension\.(?:width|depth|height)/g)).toHaveLength(3);
    expect(sql).toContain("position between 0 and 31");
    expect(sql).toContain("unit in ('mm', 'cm', 'm', 'in')");
    expect(sql).toContain("number_value between 0 and 5");
    expect(sql).toContain("url_value ~ '^https://");
    expect(sql).toContain("url_value !~ '^https://[^/]*@'");
    expect(sql).toContain("url_value ~* '\\.(glb|gltf|usdz)");
    expect(sql).toContain("alter table public.product_fact enable row level security");
    expect(sql).toContain("shop_id = public.current_shop_id()");
  });
});
