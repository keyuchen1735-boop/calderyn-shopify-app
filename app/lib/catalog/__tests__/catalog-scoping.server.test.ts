import { describe, it, expect, vi } from "vitest";

vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: vi.fn() }));
// The parent product_dim UPDATE matches no row (the product is not this shop's):
// Supabase returns { data: [], error: null }, so the code must treat that as 404
// and must NOT proceed to the child writes. The pre-write stock guard's reads
// (select().eq().eq(), awaited directly) see no rows either.
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
      update: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }),
    }),
  }),
}));

describe("catalog write tenant scoping", () => {
  it("updateProduct throws not_found when no owned product matches", async () => {
    const { updateProduct } = await import("../catalog.server");
    await expect(updateProduct("shop1", "pX", { title: "T", status: "active", variants: [{ sku: "s" }] }))
      .rejects.toThrow("product not found");
  });
  it("setProductStatus throws not_found when no owned product matches", async () => {
    const { setProductStatus } = await import("../catalog.server");
    await expect(setProductStatus("shop1", "pX", "archived")).rejects.toThrow("product not found");
  });
});
