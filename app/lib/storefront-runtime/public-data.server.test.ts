import { describe, expect, it, vi } from "vitest";
import type { StorefrontCatalog, StoreProduct } from "~/lib/storefront/catalog";
import { parseStorefrontSearchParams } from "~/lib/storefront/search.server";
import { PublicDataPlanError, resolvePublicData } from "./public-data.server";

const { policyLinksLoaderMock } = vi.hoisted(() => ({ policyLinksLoaderMock: vi.fn() }));
vi.mock("~/lib/storefront/policies.server", () => ({
  loadStorefrontPolicyLinks: (...args: unknown[]) => policyLinksLoaderMock(...args),
}));

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
    listProductPage: vi.fn(async (_shopId, opts) => {
      const selected = opts.collection
        ? products.filter((entry) => entry.collections.includes(opts.collection!))
        : products;
      const offset = opts.cursor ? Number(opts.cursor) : 0;
      const items = selected.slice(offset, offset + opts.limit);
      const next = offset + items.length;
      return { items, nextCursor: next < selected.length ? String(next) : null };
    }),
    listProducts: vi.fn(async (_shopId, opts) => {
      const selected = opts?.ids
        ? products.filter((entry) => opts.ids!.includes(entry.id))
        : opts?.collection
        ? products.filter((entry) => entry.collections.includes(opts.collection!))
        : products;
      return selected.slice(0, opts?.limit);
    }),
    getProduct: vi.fn(async (_shopId, handle) => products.find((entry) => entry.handle === handle) ?? null),
    getCollection: vi.fn(async (_shopId, handle) => handle === "featured"
      ? { id: "collection-featured", handle, title: "Featured", description: "All featured", productCount: products.length }
      : null),
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
  it("loads live merchant policy links with the server-resolved tenant by default", async () => {
    policyLinksLoaderMock.mockResolvedValueOnce([
      { id: "privacy", title: "Privacy policy", href: "/storefront/policies/privacy" },
      { id: "refund", title: "Returns", href: "/storefront/policies/refund" },
    ]);

    const data = await resolvePublicData({
      shopId: SHOP,
      requiredData: [{ kind: "policyLinks" }],
      route: { kind: "home" },
    }, { catalog: catalog(), settingsLoader });

    expect(policyLinksLoaderMock).toHaveBeenCalledWith(SHOP);
    expect(data.policyLinks).toEqual([
      { id: "privacy", title: "Privacy policy", href: "/storefront/policies/privacy" },
      { id: "refund", title: "Returns", href: "/storefront/policies/refund" },
    ]);
  });

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
    expect(fake.listProductPage).toHaveBeenCalledWith(SHOP, { cursor: null, limit: 24 });
    expect(fake.listProducts).toHaveBeenNthCalledWith(2, SHOP, {
      ids: expect.any(Array),
      limit: 24,
    });
    expect(vi.mocked(fake.listProducts).mock.calls[1]?.[1]?.ids).toHaveLength(24);
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

  it("keeps the complete merchant description on runtime product and card data", async () => {
    const described = { ...product("one"), description: "First <detail> through the complete ending." };
    const data = await resolvePublicData({
      shopId: SHOP,
      requiredData: [{ kind: "currentProduct" }, { kind: "featuredProducts", limit: 1 }],
      route: { kind: "product", handle: "one" },
    }, { catalog: catalog([described]), settingsLoader });

    expect(data.product?.description).toBe(described.description);
    expect(data.featuredProducts[0]?.description).toBe(described.description);
  });

  it("uses a direct collection lookup and keeps the total separate from the 24-product slice", async () => {
    const fake = catalog(Array.from({ length: 40 }, (_, index) => product(String(index))));
    const data = await resolvePublicData({
      shopId: SHOP,
      requiredData: [{ kind: "currentCollection" }],
      route: { kind: "collection", handle: "featured" },
    }, { catalog: fake, settingsLoader });
    expect(fake.getCollection).toHaveBeenCalledWith(SHOP, "featured");
    expect(fake.listCollections).not.toHaveBeenCalled();
    expect(data.collection?.products).toHaveLength(24);
    expect(data.collection?.productCount).toBe(40);
  });

  it.each([
    ["daily wash", "description-match"],
    ["wellness", "category-match"],
    ["vegan", "tag-match"],
  ])("uses Task 6 full-field search for runtime-1 query %s", async (query, expectedHandle) => {
    const products = [
      { ...product("description-match"), title: "Cleanser", description: "Gentle daily wash" },
      { ...product("category-match"), title: "Tonic", category: "Wellness" },
      { ...product("tag-match"), title: "Cream", tags: ["vegan"] },
    ];
    const fake = catalog(products);
    const searchInput = parseStorefrontSearchParams(new URL(`https://shop.example/?q=${encodeURIComponent(query)}`).searchParams);
    const data = await resolvePublicData({
      shopId: SHOP,
      requiredData: [{ kind: "searchResults", limit: 24 }],
      route: { kind: "search", query, searchInput },
    }, { catalog: fake, settingsLoader });
    expect(data.search?.results.map((entry) => entry.handle)).toEqual([expectedHandle]);
  });

  it("preserves Task 6 sort and cursor while hydrating bounded full product DTOs", async () => {
    const cheap = { ...product("cheap"), title: "Zed", variants: [{ ...product("cheap").variants[0], priceCents: 100 }] };
    const expensive = { ...product("expensive"), title: "Able", variants: [{ ...product("expensive").variants[0], priceCents: 900 }] };
    const fake = catalog([cheap, expensive]);
    const firstInput = parseStorefrontSearchParams(new URL("https://shop.example/?sort=price_desc&limit=1").searchParams);
    const first = await resolvePublicData({
      shopId: SHOP,
      requiredData: [{ kind: "searchResults", limit: 24 }],
      route: { kind: "search", query: "", searchInput: firstInput },
    }, { catalog: fake, settingsLoader });
    expect(first.search?.results[0]).toMatchObject({ handle: "expensive", description: "Description expensive" });
    expect(first.search?.nextCursor).toEqual(expect.any(String));

    const secondInput = parseStorefrontSearchParams(new URL(`https://shop.example/?sort=price_desc&limit=1&cursor=${encodeURIComponent(first.search!.nextCursor!)}`).searchParams);
    const second = await resolvePublicData({
      shopId: SHOP,
      requiredData: [{ kind: "searchResults", limit: 24 }],
      route: { kind: "search", query: "", searchInput: secondInput },
    }, { catalog: fake, settingsLoader });
    expect(second.search?.results.map((entry) => entry.handle)).toEqual(["cheap"]);
  });

  it("changes collection products when an allowlisted Task 6 facet changes", async () => {
    const vegan = { ...product("vegan"), tags: ["vegan"] };
    const wool = { ...product("wool"), tags: ["wool"] };
    const fake = catalog([vegan, wool]);
    const searchInput = parseStorefrontSearchParams(new URL("https://shop.example/?collection=featured&tag=vegan").searchParams);
    const data = await resolvePublicData({
      shopId: SHOP,
      requiredData: [{ kind: "currentCollection" }],
      route: { kind: "collection", handle: "featured", searchInput },
    }, { catalog: fake, settingsLoader });
    expect(data.collection?.products.map((entry) => entry.handle)).toEqual(["vegan"]);
    expect(data.collection?.productCount).toBe(1);
  });

  it("resolves live identity/media on every request but excludes release-owned design fields", async () => {
    const listProducts = vi.fn()
      .mockResolvedValueOnce([product("one", "https://signed.example/first")])
      .mockResolvedValueOnce([product("one", "https://signed.example/second")]);
    const fake: StorefrontCatalog = {
      listProductPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listProducts,
      getProduct: vi.fn(async () => null),
      getCollection: vi.fn(async () => null),
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
