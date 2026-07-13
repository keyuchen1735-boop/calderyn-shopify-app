import { describe, expect, it, vi } from "vitest";
import type { StorefrontCatalog, StoreProduct } from "~/lib/storefront/catalog";
import { PublicDataPlanError, resolvePublicData } from "./public-data.server";

const SHOP = "11111111-1111-1111-1111-111111111111";

function product(handle: string, imageUrl = "https://media.example/one.jpg"): StoreProduct {
  return {
    id: `product-${handle}`,
    handle,
    title: `Title ${handle}`,
    description: `Description ${handle}`,
    images: [{ url: imageUrl, alt: `Alt ${handle}` }],
    variants: [{
      id: `variant-${handle}`,
      sku: null,
      title: "Default",
      priceCents: 1299,
      compareAtPriceCents: 1599,
      currency: "USD",
      available: true,
    }],
    collections: ["featured"],
  };
}

function catalog(products = [product("one"), product("two")]): StorefrontCatalog {
  return {
    listProducts: vi.fn(async (_shopId, opts) => {
      const selected = opts?.collection
        ? products.filter((entry) => entry.collections.includes(opts.collection!))
        : products;
      return selected.slice(0, opts?.limit);
    }),
    getProduct: vi.fn(async (_shopId, handle) => products.find((entry) => entry.handle === handle) ?? null),
    listCollections: vi.fn(async () => [{ handle: "featured", title: "Featured" }]),
  };
}

const settingsLoader = vi.fn(async () => ({
  shopId: SHOP,
  storeName: "Live <Store>",
  logoUrl: "https://media.example/logo.svg",
  palette: { primary: "#f00", background: "#fff", text: "#000" },
  voiceTagline: "This belongs to the pinned bundle",
  vibe: "bold" as const,
  typeStyle: "editorial" as const,
  density: "roomy" as const,
}));

describe("runtime-1 public data plans", () => {
  it("rejects invented and over-limit plans before any catalog read", async () => {
    const fake = catalog();
    await expect(resolvePublicData({
      shopId: SHOP,
      requiredData: [{ kind: "featuredProducts", limit: 13 }],
      route: { kind: "home" },
    }, { catalog: fake, settingsLoader })).rejects.toBeInstanceOf(PublicDataPlanError);
    await expect(resolvePublicData({
      shopId: SHOP,
      requiredData: [{ kind: "arbitraryJoin", limit: 1 } as never],
      route: { kind: "home" },
    }, { catalog: fake, settingsLoader })).rejects.toBeInstanceOf(PublicDataPlanError);
    expect(fake.listProducts).not.toHaveBeenCalled();
  });

  it("passes the server-resolved shop first and caps every requested list", async () => {
    const fake = catalog(Array.from({ length: 30 }, (_, index) => product(String(index))));
    const data = await resolvePublicData({
      shopId: SHOP,
      requiredData: [
        { kind: "storeIdentity" },
        { kind: "featuredProducts", limit: 12, collectionHandle: "featured" },
        { kind: "searchResults", limit: 24 },
      ],
      route: { kind: "search", query: "title" },
    }, { catalog: fake, settingsLoader });
    expect(fake.listProducts).toHaveBeenNthCalledWith(1, SHOP, { collection: "featured", limit: 12 });
    expect(fake.listProducts).toHaveBeenNthCalledWith(2, SHOP, { limit: 24, query: "title" });
    expect(data.featuredProducts).toHaveLength(12);
    expect(data.search?.results).toHaveLength(24);
  });

  it("turns missing route records into an explicit platform 404 and removes missing references", async () => {
    const fake = catalog([product("one")]);
    const data = await resolvePublicData({
      shopId: SHOP,
      requiredData: [{ kind: "currentProduct" }, { kind: "relatedProducts", limit: 8 }],
      route: { kind: "product", handle: "missing" },
    }, { catalog: fake, settingsLoader });
    expect(data.notFound).toEqual({ kind: "product", handle: "missing" });
    expect(data.product).toBeNull();
    expect(data.relatedProducts).toEqual([]);
  });

  it("resolves live identity/media on every request but excludes release-owned design fields", async () => {
    const listProducts = vi.fn()
      .mockResolvedValueOnce([product("one", "https://signed.example/first")])
      .mockResolvedValueOnce([product("one", "https://signed.example/second")]);
    const fake: StorefrontCatalog = {
      listProducts,
      getProduct: vi.fn(async () => null),
      listCollections: vi.fn(async () => []),
    };
    const input = {
      shopId: SHOP,
      requiredData: [{ kind: "storeIdentity" }, { kind: "featuredProducts", limit: 1 }] as const,
      route: { kind: "home" as const },
    };
    const first = await resolvePublicData(input, { catalog: fake, settingsLoader });
    const second = await resolvePublicData(input, { catalog: fake, settingsLoader });
    expect(first.store).toEqual({ name: "Live <Store>", logo: "https://media.example/logo.svg" });
    expect(first.store).not.toHaveProperty("palette");
    expect(first.store).not.toHaveProperty("voiceTagline");
    expect(first.featuredProducts[0].primaryImage?.url).toBe("https://signed.example/first");
    expect(second.featuredProducts[0].primaryImage?.url).toBe("https://signed.example/second");
  });
});
