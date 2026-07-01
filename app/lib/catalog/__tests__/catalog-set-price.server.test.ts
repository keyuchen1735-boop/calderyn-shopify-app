import { describe, it, expect, vi, beforeEach } from "vitest";
const project = vi.fn().mockResolvedValue(undefined);
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: project }));
const maybeSingle = vi.fn().mockResolvedValue({ data: { product_id: "p1", retail_price_cents: 1999 }, error: null });
const update = vi.fn(() => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }), update }) }),
}));
beforeEach(() => { project.mockClear(); });

describe("setVariantPrice", () => {
  it("writes the new price, returns the prior, and re-projects", async () => {
    const { setVariantPrice } = await import("../catalog.server");
    const r = await setVariantPrice("shop1", "v1", 2499);
    expect(r).toEqual({ priorPriceCents: 1999 });
    expect(project).toHaveBeenCalledWith("p1");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ retail_price_cents: 2499 }));
  });
});
