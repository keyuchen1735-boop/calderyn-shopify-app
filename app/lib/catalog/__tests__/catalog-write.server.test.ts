import { describe, it, expect, vi, beforeEach } from "vitest";

const project = vi.fn().mockResolvedValue(undefined);
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: project }));

const single = vi.fn().mockResolvedValue({ data: { id: "p1" }, error: null });
// One insert mock that supports both `.insert(x).select("id").single()` (product /
// option / variant) and `await .insert(x)` (link tables), so the create path's
// variant insert (which chains select().single()) works.
const insert = vi.fn(() => ({
  select: () => ({ single }),
  then: (resolve: (r: { error: null }) => unknown) => resolve({ error: null }),
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ insert, upsert: () => Promise.resolve({ error: null }), delete: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
  }),
}));

beforeEach(() => { project.mockClear(); insert.mockClear(); });

describe("validateProductInput", () => {
  it("rejects a product with no variants", async () => {
    const { validateProductInput } = await import("../validate");
    const r = validateProductInput({ title: "Tee", status: "active", variants: [] });
    expect(r.ok).toBe(false);
  });
});

describe("createProduct", () => {
  it("creates the product and re-projects sku_dim", async () => {
    const { createProduct } = await import("../catalog.server");
    const res = await createProduct("shop1", {
      title: "Tee", status: "active", variants: [{ sku: "T-S", retailPriceCents: 1999, inventoryOnHand: 5 }],
    });
    expect(res.id).toBe("p1");
    expect(project).toHaveBeenCalledWith("p1");
  });
});
