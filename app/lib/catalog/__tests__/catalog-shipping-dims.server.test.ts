/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory supabase fake */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store: Record<string, any[]> = {};
const inserts: Array<{ table: string; rows: any }> = [];
function builder(table: string): any {
  const api: any = {
    select: () => api, eq: () => api, in: () => api, order: () => api,
    maybeSingle: async () => ({ data: (store[table] ?? [])[0] ?? null, error: null }),
    single: async () => ({ data: { id: `${table}-id` }, error: null }),
    insert: (rows: any) => {
      inserts.push({ table, rows });
      const chain: any = { select: () => chain, single: async () => ({ data: { id: `${table}-id` }, error: null }) };
      return chain;
    },
    update: () => api, delete: () => api,
    then: (r: (x: { data: any; error: null }) => unknown) => r({ data: store[table] ?? [], error: null }),
  };
  return api;
}
vi.mock("../../supabase.server", () => ({ getSupabase: () => ({ from: (t: string) => builder(t) }) }));
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: async () => {} }));

let createProduct: typeof import("../catalog.server").createProduct;
let getProduct: typeof import("../catalog.server").getProduct;
beforeEach(async () => {
  vi.resetModules();
  inserts.length = 0;
  Object.keys(store).forEach((k) => delete store[k]);
  ({ createProduct, getProduct } = await import("../catalog.server"));
});

const SHOP = "00000000-0000-0000-0000-000000000001";
const base = {
  title: "Tee", status: "active" as const,
  variants: [{ title: "S", grams: 500, lengthMm: 200, widthMm: 150, heightMm: 100 }],
};

describe("createProduct shipping dims", () => {
  it("persists grams + length/width/height_mm on the variant insert", async () => {
    await createProduct(SHOP, base as any);
    const v = inserts.find((i) => i.table === "variant_dim");
    expect(v).toBeTruthy();
    expect(v!.rows).toMatchObject({ grams: 500, length_mm: 200, width_mm: 150, height_mm: 100 });
  });

  it("throws before writing when a dimension is invalid", async () => {
    const bad = { ...base, variants: [{ title: "S", lengthMm: 0 }] };
    await expect(createProduct(SHOP, bad as any)).rejects.toThrow(/lengthMm/);
    expect(inserts.find((i) => i.table === "variant_dim")).toBeFalsy();
  });
});

describe("getProduct shipping dims", () => {
  it("maps grams + length/width/height_mm into the variant DTO", async () => {
    store["product_dim"] = [{ id: "p1", title: "Tee", status: "active", vendor: null, category: null, description: null, tags: [], updated_at: "t" }];
    store["variant_dim"] = [{ id: "v1", sku: "S", title: "S", retail_price_cents: 1999, unit_cost_cents: null, inventory_tracked: true, inventory_on_hand: 3, position: 0, grams: 500, length_mm: 200, width_mm: 150, height_mm: 100 }];
    const detail = await getProduct(SHOP, "p1");
    expect(detail!.variants[0]).toMatchObject({ grams: 500, lengthMm: 200, widthMm: 150, heightMm: 100 });
  });
});
