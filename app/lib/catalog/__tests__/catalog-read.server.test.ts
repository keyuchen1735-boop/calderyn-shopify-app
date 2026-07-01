import { describe, it, expect, vi, beforeEach } from "vitest";

const productsQuery = { data: [{ id: "p1", title: "Tee", status: "active", updated_at: "2026-06-28T00:00:00Z" }], count: 1, error: null };
const mediaQuery = { data: [{ product_id: "p1", storage_path: "a.jpg" }], error: null };
const variantCountQuery = { data: [{ product_id: "p1" }, { product_id: "p1" }], error: null };

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "product_dim") {
        // listProducts chains .order("updated_at").order("id").range(...)
        const range = () => Promise.resolve(productsQuery);
        const ordered: { order: () => typeof ordered; range: typeof range } = {
          order: () => ordered,
          range,
        };
        return { select: () => ({ eq: () => ordered }) };
      }
      if (table === "product_media") {
        return { select: () => ({ in: () => ({ eq: () => Promise.resolve(mediaQuery) }) }) };
      }
      // variant_dim
      return { select: () => ({ in: () => Promise.resolve(variantCountQuery) }) };
    },
  }),
}));

beforeEach(() => {});

describe("listProducts", () => {
  it("returns summaries with primary image + variant count", async () => {
    const { listProducts } = await import("../catalog.server");
    const { products, total } = await listProducts("shop1", {});
    expect(total).toBe(1);
    expect(products[0]).toEqual(expect.objectContaining({ id: "p1", variantCount: 2, primaryImagePath: "a.jpg" }));
  });
});
