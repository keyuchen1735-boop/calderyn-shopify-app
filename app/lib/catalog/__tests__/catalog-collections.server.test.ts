import { describe, it, expect, vi } from "vitest";
const single = vi.fn().mockResolvedValue({ data: { id: "c1" }, error: null });
const insert = vi.fn(() => ({ select: () => ({ single }) }));
const order = vi.fn().mockResolvedValue({ data: [{ id: "c1", title: "Summer", handle: "summer" }], error: null });
// Membership rows for the count fold: two products in c1.
const memberships = vi
  .fn()
  .mockResolvedValue({ data: [{ collection_id: "c1" }, { collection_id: "c1" }], error: null });
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "product_collection") {
        return { select: () => ({ in: memberships }) };
      }
      return { insert, select: () => ({ eq: () => ({ order }) }) };
    },
  }),
}));
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: vi.fn() }));

describe("collections", () => {
  it("lists collections with folded membership counts", async () => {
    const { listCollections } = await import("../catalog.server");
    expect(await listCollections("shop1")).toEqual([
      { id: "c1", title: "Summer", handle: "summer", productCount: 2 },
    ]);
  });
  it("creates a collection with a slug handle", async () => {
    const { createCollection } = await import("../catalog.server");
    expect(await createCollection("shop1", "Summer Sale")).toEqual({ id: "c1" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ shop_id: "shop1", title: "Summer Sale", handle: "summer-sale" }));
  });
});
