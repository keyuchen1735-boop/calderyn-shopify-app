// app/lib/storefront/__tests__/catalog.contract.test.ts
import { describe, it, expect } from "vitest";
import type {
  StorefrontCatalog,
  StoreProduct,
  StoreVariant,
  StoreCollection,
} from "../catalog";

describe("StorefrontCatalog contract", () => {
  it("is implementable with the documented DTO shapes and shopId-first methods", async () => {
    const variant: StoreVariant = {
      id: "v1",
      sku: "SKU-1",
      title: "Default",
      priceCents: 1999,
      currency: "USD",
      available: true,
    };
    const collection: StoreCollection = { handle: "apparel", title: "Apparel" };
    const product: StoreProduct = {
      id: "p1",
      handle: "tee",
      title: "Tee",
      description: "A tee.",
      images: [{ url: "https://img.example/1.jpg", alt: "Tee" }],
      variants: [variant],
      collections: ["apparel"],
    };

    const cat: StorefrontCatalog = {
      searchProductPage: async (_shopId, opts) => ({
        items: [product].slice(0, opts.limit),
        facets: { categories: [], tags: [], collections: [] },
        total: 1,
        hasNextPage: false,
      }),
      listProductPage: async (_shopId, opts) => ({ items: [product].slice(0, opts.limit), nextCursor: null }),
      listProducts: async (shopId, opts) => {
        expect(typeof shopId).toBe("string");
        return opts?.collection ? [product].filter((p) => p.collections.includes(opts.collection!)) : [product];
      },
      getProduct: async (_shopId, handle) => (handle === product.handle ? product : null),
      listCollections: async (_shopId) => [collection],
    };

    expect((await cat.listProducts("demo-shop")).length).toBe(1);
    expect((await cat.listProductPage("demo-shop", { limit: 24 })).items).toEqual([product]);
    expect((await cat.listProducts("demo-shop", { collection: "apparel" })).length).toBe(1);
    expect(await cat.getProduct("demo-shop", "tee")).toEqual(product);
    expect(await cat.getProduct("demo-shop", "nope")).toBeNull();
    expect((await cat.listCollections("demo-shop"))[0].handle).toBe("apparel");
  });
});
