// app/lib/storegen/imagery/detector.test.ts
import { describe, it, expect } from "vitest";
import { findImprovableListings } from "./detector";
import type { StoreProduct } from "~/lib/storefront/catalog";

const p = (id: string, imgs: number): StoreProduct => ({
  id, handle: `h-${id}`, title: `P${id}`, description: "", collections: [],
  images: Array.from({ length: imgs }, (_, i) => ({ url: `/i/${id}-${i}.jpg`, alt: null })),
  variants: [{ id: `v-${id}`, sku: null, title: "D", priceCents: 1000, currency: "USD", available: true }],
});

describe("findImprovableListings", () => {
  it("flags products with zero or one image, ranks zero-image first", () => {
    const out = findImprovableListings([p("a", 2), p("b", 0), p("c", 1)]);
    expect(out.map((x) => x.productId)).toEqual(["b", "c"]); // a (2 imgs) not flagged
    expect(out[0].reason).toMatch(/no image/i);
    expect(out[1].reason).toMatch(/single image/i);
  });
  it("returns nothing when every product has 2+ images", () => {
    expect(findImprovableListings([p("a", 3), p("b", 2)])).toHaveLength(0);
  });
});
