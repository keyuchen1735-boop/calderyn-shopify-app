// app/lib/storefront/__tests__/catalog.server.test.ts
import { beforeEach, describe, it, expect, vi } from "vitest";
import type { StorefrontCatalog } from "../catalog";
import { getCatalog, getPreviewCatalog } from "../catalog.server";
import { fixtureCatalog } from "../catalog.stub.server";

const { assetRows, fromMock, eqMock, inMock, orderMock, rangeMock } = vi.hoisted(() => {
  const assetRows = { current: [] as Array<Record<string, unknown>> };
  const eqMock = vi.fn();
  const inMock = vi.fn();
  const orderMock = vi.fn();
  const rangeMock = vi.fn(async () => ({ data: assetRows.current, error: null }));
  const query = { eq: eqMock, in: inMock, order: orderMock, range: rangeMock };
  eqMock.mockReturnValue(query);
  inMock.mockReturnValue(query);
  orderMock.mockReturnValue(query);
  return {
    assetRows,
    eqMock,
    inMock,
    orderMock,
    rangeMock,
    fromMock: vi.fn(() => ({ select: () => query })),
  };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));

vi.mock("../catalog.owned.server", () => ({
  listOwnedPreviewProducts: vi.fn(async (shopId: string) => [{
    id: "draft", handle: `draft-for-${shopId}`, title: "Draft", description: "", images: [], variants: [], collections: [],
  }]),
  ownedCatalog: {
    searchProductPage: vi.fn(async (shopId: string) => ({
      items: [{ id: "owned", handle: `owned-for-${shopId}`, title: "Owned", images: [] }],
      facets: { categories: [], tags: [], collections: [] },
      total: 1,
      hasNextPage: false,
    })),
    listProductPage: vi.fn(async (shopId: string) => ({ items: [{ id: "owned", handle: `owned-for-${shopId}`, title: "Owned", images: [] }], nextCursor: null })),
    listProducts: vi.fn(async (shopId: string) => [{ id: "owned", handle: `owned-for-${shopId}`, title: "Owned", images: [] }]),
    getProduct: vi.fn(async () => null),
    listCollections: vi.fn(async () => [{ handle: "owned", title: "Owned" }]),
    getCollection: vi.fn(async (_shopId: string, handle: string) => ({
      handle,
      title: "Owned collection",
      productCount: 37,
    })),
  },
}));

const SHOP = "demo-shop";
const UUID_SHOP = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  assetRows.current = [];
  fromMock.mockClear();
  eqMock.mockClear();
  inMock.mockClear();
  orderMock.mockClear();
  rangeMock.mockClear();
});

// A consumer shaped exactly like the home loader: it only ever talks to the
// StorefrontCatalog contract, so any conforming impl must drive it identically.
async function loadHome(cat: StorefrontCatalog, shopId: string) {
  return {
    collections: await cat.listCollections(shopId),
    products: await cat.listProducts(shopId),
  };
}

describe("getCatalog", () => {
  it("uses the private preview catalog for real tenants without changing the public seam", async () => {
    const products = await getPreviewCatalog().listProducts(UUID_SHOP);
    const { listOwnedPreviewProducts, ownedCatalog } = await import("../catalog.owned.server");
    expect(products[0].handle).toBe(`draft-for-${UUID_SHOP}`);
    expect(listOwnedPreviewProducts).toHaveBeenCalledWith(UUID_SHOP, undefined);
    expect(ownedCatalog.listProducts).not.toHaveBeenCalledWith(UUID_SHOP, undefined);
  });

  it("routes public product pages through the tenant seam", async () => {
    await getCatalog().listProductPage(UUID_SHOP, { limit: 24 });
    const { ownedCatalog } = await import("../catalog.owned.server");
    expect(ownedCatalog.listProductPage).toHaveBeenCalledWith(UUID_SHOP, { limit: 24 });
  });

  it("routes a real (uuid) tenant to the owned catalog", async () => {
    const products = await getCatalog().listProducts(UUID_SHOP);
    expect(products[0].handle).toBe(`owned-for-${UUID_SHOP}`);
  });

  it("serves ready owned imagery through the normal public catalog", async () => {
    assetRows.current = [{
      product_id: "owned",
      url: "https://owned.example/generated.webp",
      status: "ready",
      created_at: "2026-07-16T12:00:00.000Z",
    }];
    const products = await getCatalog().listProducts(UUID_SHOP);

    expect(fromMock).toHaveBeenCalledWith("store_asset");
    expect(eqMock.mock.calls).toEqual([
      ["shop_id", UUID_SHOP],
      ["status", "ready"],
    ]);
    expect(inMock).toHaveBeenCalledWith("product_id", ["owned"]);
    expect(products[0].images).toEqual([{
      url: "https://owned.example/generated.webp",
      alt: "Owned",
    }]);
  });

  it("routes bounded collection lookups through the same tenant seam", async () => {
    const collection = await getCatalog().getCollection?.(UUID_SHOP, "apparel");
    const { ownedCatalog } = await import("../catalog.owned.server");

    expect(ownedCatalog.getCollection).toHaveBeenCalledWith(UUID_SHOP, "apparel");
    expect(collection).toMatchObject({ handle: "apparel", productCount: 37 });
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
      async searchProductPage() {
        return {
          items: [novel], facets: { categories: [], tags: [], collections: [] }, total: 1, hasNextPage: false,
        };
      },
      async listProductPage() {
        return { items: [novel], nextCursor: null };
      },
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
