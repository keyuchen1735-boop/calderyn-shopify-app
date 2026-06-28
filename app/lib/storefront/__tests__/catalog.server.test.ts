// app/lib/storefront/__tests__/catalog.server.test.ts
import { describe, it, expect } from "vitest";
import type { StorefrontCatalog } from "../catalog";
import { getCatalog } from "../catalog.server";

const SHOP = "demo-shop";

// A consumer shaped exactly like the home loader: it only ever talks to the
// StorefrontCatalog contract, so any conforming impl must drive it identically.
async function loadHome(cat: StorefrontCatalog, shopId: string) {
  return {
    collections: await cat.listCollections(shopId),
    products: await cat.listProducts(shopId),
  };
}

describe("getCatalog", () => {
  it("returns the fixture catalog by default", async () => {
    const home = await loadHome(getCatalog(), SHOP);
    expect(home.collections.length).toBe(2);
    expect(home.products.length).toBe(4);
  });

  it("the seam holds: a second fake impl drives the same consumer unchanged", async () => {
    const secondFake: StorefrontCatalog = {
      async listCollections() {
        return [{ handle: "books", title: "Books" }];
      },
      async listProducts() {
        return [
          {
            id: "f1",
            handle: "novel",
            title: "Novel",
            description: "",
            images: [],
            variants: [{ id: "fv1", sku: null, title: "Default", priceCents: 1200, currency: "USD", available: true }],
            collections: ["books"],
          },
        ];
      },
      async getProduct(_shopId, handle) {
        return handle === "novel"
          ? {
              id: "f1",
              handle: "novel",
              title: "Novel",
              description: "",
              images: [],
              variants: [{ id: "fv1", sku: null, title: "Default", priceCents: 1200, currency: "USD", available: true }],
              collections: ["books"],
            }
          : null;
      },
    };

    const fromFixture = await loadHome(getCatalog(), SHOP);
    const fromFake = await loadHome(secondFake, SHOP);

    expect(fromFixture.products.map((p) => p.handle)).not.toContain("novel");
    expect(fromFake.collections[0].handle).toBe("books");
    expect(fromFake.products[0].handle).toBe("novel");
  });
});
