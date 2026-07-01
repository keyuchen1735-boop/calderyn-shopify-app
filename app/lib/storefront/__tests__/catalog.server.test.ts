// app/lib/storefront/__tests__/catalog.server.test.ts
import { describe, it, expect } from "vitest";
import type { StorefrontCatalog } from "../catalog";
import { getCatalog } from "../catalog.server";
import { ownedCatalog } from "../catalog.owned.server";
import { fixtureCatalog } from "../catalog.stub.server";

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
  it("returns the owned (DB-bound) catalog now that Slice 1 has landed", () => {
    // The one-line swap is flipped from the in-memory fixture to the owned impl,
    // so the storefront reads real products. (Asserted by reference to avoid a DB
    // call; the owned impl's behavior is covered in catalog.owned.server.test.ts.)
    expect(getCatalog()).toBe(ownedCatalog);
  });

  it("the seam holds: any conforming impl drives the same consumer unchanged", async () => {
    const novel = {
      id: "f1",
      handle: "novel",
      title: "Novel",
      description: "",
      images: [],
      variants: [{ id: "fv1", sku: null, title: "Default", priceCents: 1200, currency: "USD", available: true }],
      collections: ["books"],
    };
    const secondFake: StorefrontCatalog = {
      async listCollections() {
        return [{ handle: "books", title: "Books" }];
      },
      async listProducts() {
        return [novel];
      },
      async getProduct(_shopId, handle) {
        return handle === "novel" ? novel : null;
      },
    };

    // The fixture (no DB) and the fake drive the identical consumer shape.
    const fromFixture = await loadHome(fixtureCatalog, SHOP);
    const fromFake = await loadHome(secondFake, SHOP);

    expect(fromFixture.products.map((p) => p.handle)).not.toContain("novel");
    expect(fromFake.collections[0].handle).toBe("books");
    expect(fromFake.products[0].handle).toBe("novel");
  });
});
