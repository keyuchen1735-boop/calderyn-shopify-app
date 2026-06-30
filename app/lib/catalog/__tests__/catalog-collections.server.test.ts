import { describe, it, expect, vi } from "vitest";
const single = vi.fn().mockResolvedValue({ data: { id: "c1" }, error: null });
const insert = vi.fn(() => ({ select: () => ({ single }) }));
const order = vi.fn().mockResolvedValue({ data: [{ id: "c1", title: "Summer", handle: "summer" }], error: null });
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ insert, select: () => ({ eq: () => ({ order }) }) }) }),
}));
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: vi.fn() }));

describe("collections", () => {
  it("lists collections", async () => {
    const { listCollections } = await import("../catalog.server");
    expect(await listCollections("shop1")).toEqual([{ id: "c1", title: "Summer", handle: "summer" }]);
  });
  it("creates a collection with a slug handle", async () => {
    const { createCollection } = await import("../catalog.server");
    expect(await createCollection("shop1", "Summer Sale")).toEqual({ id: "c1" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ shop_id: "shop1", title: "Summer Sale", handle: "summer-sale" }));
  });
});
