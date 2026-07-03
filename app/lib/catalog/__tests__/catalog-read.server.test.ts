import { describe, it, expect, vi, beforeEach } from "vitest";

const productsQuery = { data: [{ id: "p1", title: "Tee", status: "active", updated_at: "2026-06-28T00:00:00Z" }], count: 1, error: null };
const mediaQuery = { data: [{ product_id: "p1", storage_path: "a.jpg" }], error: null };

// Mutable per-test fixtures for the variant + shipping reads.
let variantRows: Array<Record<string, unknown>> = [];
let shippingRows: Array<Record<string, unknown>> = [];

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
        // .select().in().eq(is_primary).not(storage_path,is,null)
        return { select: () => ({ in: () => ({ eq: () => ({ not: () => Promise.resolve(mediaQuery) }) }) }) };
      }
      if (table === "variant_shipping") {
        // listProducts chains .eq("shop_id").in("variant_id", chunk)
        return { select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: shippingRows, error: null }) }) }) };
      }
      // variant_dim
      return { select: () => ({ in: () => Promise.resolve({ data: variantRows, error: null }) }) };
    },
  }),
}));

beforeEach(() => {
  variantRows = [
    { id: "v1", product_id: "p1", retail_price_cents: 1999 },
    { id: "v2", product_id: "p1", retail_price_cents: 2499 },
  ];
  shippingRows = [
    { variant_id: "v1", weight_grams: 340, length_mm: 127, width_mm: 127, height_mm: 102, requires_shipping: true },
    { variant_id: "v2", weight_grams: 0, length_mm: null, width_mm: null, height_mm: null, requires_shipping: false },
  ];
});

describe("listProducts", () => {
  it("returns summaries with primary image + variant count", async () => {
    const { listProducts } = await import("../catalog.server");
    const { products, total } = await listProducts("shop1", {});
    expect(total).toBe(1);
    expect(products[0]).toEqual(expect.objectContaining({ id: "p1", variantCount: 2, primaryImagePath: "a.jpg" }));
  });

  it("rolls up min variant price and heaviest physical weight", async () => {
    const { listProducts } = await import("../catalog.server");
    const { products } = await listProducts("shop1", {});
    expect(products[0].priceCents).toBe(1999);
    expect(products[0].shipDataOk).toBe(true); // physical complete + digital exempt
    expect(products[0].shipWeightGrams).toBe(340);
  });

  it("reports null price when no variant carries one", async () => {
    variantRows = [{ id: "v1", product_id: "p1", retail_price_cents: null }];
    shippingRows = [
      { variant_id: "v1", weight_grams: 340, length_mm: 127, width_mm: 127, height_mm: 102, requires_shipping: true },
    ];
    const { listProducts } = await import("../catalog.server");
    const { products } = await listProducts("shop1", {});
    expect(products[0].priceCents).toBeNull();
  });

  it("flags a physical variant missing dims as ship-incomplete (mirrors incomplete_shipping)", async () => {
    shippingRows = [
      // weight but no dims -> fails the same predicate as the activation 422
      { variant_id: "v1", weight_grams: 340, length_mm: null, width_mm: null, height_mm: null, requires_shipping: true },
      { variant_id: "v2", weight_grams: 0, requires_shipping: false },
    ];
    const { listProducts } = await import("../catalog.server");
    const { products } = await listProducts("shop1", {});
    expect(products[0].shipDataOk).toBe(false);
  });

  it("treats a variant with no variant_shipping row as physical and incomplete", async () => {
    shippingRows = [
      { variant_id: "v1", weight_grams: 340, length_mm: 127, width_mm: 127, height_mm: 102, requires_shipping: true },
      // v2 has no shipping row at all
    ];
    const { listProducts } = await import("../catalog.server");
    const { products } = await listProducts("shop1", {});
    expect(products[0].shipDataOk).toBe(false);
  });
});
