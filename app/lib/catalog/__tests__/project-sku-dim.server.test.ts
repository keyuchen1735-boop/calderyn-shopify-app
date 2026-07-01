import { describe, it, expect, vi, beforeEach } from "vitest";

const productRow = { id: "p1", shop_id: "shop-1", external_id: null, status: "active", vendor: "Acme", category: "Shirts", tags: ["summer"] };

// Mutable per-test variant set so we can exercise the empty-variants delete path.
let currentVariants: Array<Record<string, unknown>> = [];

const upsert = vi.fn().mockResolvedValue({ error: null });

// Records each delete chain so the destructive path can be asserted.
type DeleteCall = { eqProductId?: string; notInIds?: string[]; unfiltered?: boolean };
const deleteCalls: DeleteCall[] = [];
function makeDelete() {
  const rec: DeleteCall = {};
  deleteCalls.push(rec);
  const afterEq = {
    notIn: (_col: string, ids: string[]) => { rec.notInIds = ids; return Promise.resolve({ error: null }); },
    // The empty-variants branch awaits the .eq() result directly (no .notIn).
    then: (resolve: (r: { error: null }) => unknown) => { rec.unfiltered = true; return resolve({ error: null }); },
  };
  return { eq: (_col: string, val: string) => { rec.eqProductId = val; return afterEq; } };
}

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "product_dim") return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: productRow, error: null }) }) }) };
      if (table === "variant_dim") return { select: () => ({ eq: () => Promise.resolve({ data: currentVariants, error: null }) }) };
      if (table === "product_collection") return { select: () => ({ eq: () => Promise.resolve({ data: [{ collection: { title: "Summer" } }], error: null }) }) };
      // sku_dim
      return { upsert, delete: makeDelete };
    },
  }),
}));

beforeEach(() => {
  upsert.mockClear();
  deleteCalls.length = 0;
  currentVariants = [
    { id: "v1", external_id: null, inventory_item_id: null, sku: "TEE-S", title: "Tee S", price_tier: null, retail_price_cents: 1999, unit_cost_cents: 800, currency: "USD", grams: 200, inventory_policy: "deny", inventory_tracked: true },
  ];
});

describe("projectProductToSkuDim", () => {
  it("upserts a sku_dim row per variant, preserving the variant id and denormalizing product fields", async () => {
    const { projectProductToSkuDim } = await import("../project-sku-dim.server");
    await projectProductToSkuDim("p1");
    expect(upsert).toHaveBeenCalledTimes(1);
    const [rows, opts] = upsert.mock.calls[0];
    expect(opts).toEqual({ onConflict: "id" });
    expect(rows[0]).toEqual(expect.objectContaining({
      id: "v1",                       // sku_dim.id == variant_dim.id (invariant)
      product_id: "p1",               // sku_dim.product_id is NOT NULL: owned product coalesces external_id -> product uuid
      external_id: "v1",              // owned variant coalesces external_id -> variant uuid
      retail_price_cents: 1999,
      product_status: "active",
      vendor: "Acme",
      collections: ["Summer"],
      tags: ["summer"],
    }));
  });

  it("prunes sku_dim rows for variants that no longer exist (scoped to the product, keeping the live ids)", async () => {
    const { projectProductToSkuDim } = await import("../project-sku-dim.server");
    await projectProductToSkuDim("p1");
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].eqProductId).toBe("p1");   // delete scoped to this product only
    expect(deleteCalls[0].notInIds).toEqual(["v1"]); // keep the live variant; prune the rest
    expect(deleteCalls[0].unfiltered).toBeUndefined();
  });

  it("when a product has no variants, removes all of its sku_dim rows and writes none", async () => {
    currentVariants = [];
    const { projectProductToSkuDim } = await import("../project-sku-dim.server");
    await projectProductToSkuDim("p1");
    expect(upsert).not.toHaveBeenCalled();
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].eqProductId).toBe("p1");
    expect(deleteCalls[0].unfiltered).toBe(true);    // unfiltered delete: every sku_dim row for the product goes
    expect(deleteCalls[0].notInIds).toBeUndefined();
  });
});
