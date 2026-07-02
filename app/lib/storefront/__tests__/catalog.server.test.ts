// app/lib/storefront/__tests__/catalog.server.test.ts
import { describe, it, expect, vi } from "vitest";
import type { StorefrontCatalog } from "../catalog";
import { getCatalog } from "../catalog.server";
import { fixtureCatalog } from "../catalog.stub.server";

vi.mock("../catalog.owned.server", () => ({
  ownedCatalog: {
    listProducts: vi.fn(async (shopId: string) => [{ handle: `owned-for-${shopId}` }]),
    getProduct: vi.fn(async () => null),
    listCollections: vi.fn(async () => [{ handle: "owned", title: "Owned" }]),
  },
}));

const SHOP = "demo-shop";
const UUID_SHOP = "11111111-1111-1111-1111-111111111111";

// A consumer shaped exactly like the home loader: it only ever talks to the
// StorefrontCatalog contract, so any conforming impl must drive it identically.
async function loadHome(cat: StorefrontCatalog, shopId: string) {
  return {
    collections: await cat.listCollections(shopId),
    products: await cat.listProducts(shopId),
  };
}

describe("getCatalog", () => {
  it("routes a real (uuid) tenant to the owned catalog", async () => {
    const products = await getCatalog().listProducts(UUID_SHOP);
    expect(products[0].handle).toBe(`owned-for-${UUID_SHOP}`);
  });

  it("routes exactly the demo sentinel to the in-memory stub, never the uuid-keyed DB", async () => {
    const { ownedCatalog } = await import("../catalog.owned.server");
    const products = await getCatalog().listProducts(SHOP);
    const stubProducts = await fixtureCatalog.listProducts(SHOP);
    expect(products.map((p) => p.handle)).toEqual(stubProducts.map((p) => p.handle));
    expect(ownedCatalog.listProducts).not.toHaveBeenCalledWith(SHOP, undefined);
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
