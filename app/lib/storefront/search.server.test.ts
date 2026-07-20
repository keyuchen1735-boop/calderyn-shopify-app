import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreProduct } from "./catalog";
import { storefrontProofContext } from "../storefront-validation/fixtures";
import { searchProductPageInMemory } from "./catalog.stub.server";
import { normalizeProductFacts } from "./product-facts";

const catalog = vi.hoisted(() => ({ searchProductPage: vi.fn(), listProductPage: vi.fn(), listProducts: vi.fn() }));

vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({
    searchProductPage: catalog.searchProductPage,
    listProductPage: catalog.listProductPage,
    listProducts: catalog.listProducts,
  }),
}));

// eslint-disable-next-line import/first -- import follows the hoisted catalog fake
import {
  InvalidSearchRequestError,
  parseStorefrontSearchParams,
  searchStorefront,
} from "./search.server";

const products: StoreProduct[] = [
  {
    id: "p-1",
    handle: "cloud-cleanser",
    title: "Cloud Cleanser",
    description: "Gentle daily wash",
    images: [{ url: "https://cdn.example/cleanser.jpg", alt: "Cleanser" }],
    variants: [{ id: "v-1", sku: "CLOUD", title: "Default", priceCents: 2400, currency: "USD", available: true }],
    collections: ["skin"],
    category: "Beauty",
    tags: ["clean", "vegan"],
  },
  {
    id: "p-2",
    handle: "night-cream",
    title: "Night Cream",
    description: "Rich evening care",
    images: [],
    variants: [{ id: "v-2", sku: "NIGHT", title: "Default", priceCents: 4800, currency: "USD", available: false }],
    collections: ["skin"],
    category: "Beauty",
    tags: ["clean"],
  },
  {
    id: "p-3",
    handle: "tea-tonic",
    title: "Tea Tonic",
    description: "Botanical refreshment",
    images: [],
    variants: [{ id: "v-3", sku: "TEA", title: "Default", priceCents: 900, currency: "USD", available: true }],
    collections: ["drinks"],
    category: "Wellness",
    tags: ["vegan"],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_API_SECRET = "search-cursor-secret-0000000000000000000000";
  catalog.searchProductPage.mockImplementation(async (_shopId, opts) => searchProductPageInMemory(products, opts));
  catalog.listProductPage.mockResolvedValue({ items: products, nextCursor: null });
  catalog.listProducts.mockImplementation(async (_shopId: string, opts?: { query?: string }) => {
    if (!opts?.query) return products;
    const query = opts.query.toLocaleLowerCase();
    return products.filter((product) => product.title.toLocaleLowerCase().includes(query));
  });
});

describe("parseStorefrontSearchParams", () => {
  it("accepts only the bounded public query grammar", () => {
    const value = parseStorefrontSearchParams(
      new URL("https://shop.example/storefront/api/search?q=clean&collection=skin&tag=vegan&available=true&sort=price_asc&limit=12").searchParams,
    );
    expect(value).toEqual({
      query: "clean",
      collection: "skin",
      category: null,
      tag: "vegan",
      available: true,
      sort: "price_asc",
      limit: 12,
      cursor: null,
      factFilters: {},
    });
  });

  it("accepts only closed, bounded merchant fact filters", () => {
    expect(parseStorefrontSearchParams(new URL("https://shop.example/?fact.material=Walnut&fact.compatibility=Model%20X").searchParams).factFilters).toEqual({
      material: "Walnut", compatibility: "Model X",
    });
    expect(() => parseStorefrontSearchParams(new URL("https://shop.example/?fact.claim=cures").searchParams)).toThrow(InvalidSearchRequestError);
    expect(() => parseStorefrontSearchParams(new URL("https://shop.example/?fact.material=a&fact.material=b").searchParams)).toThrow(InvalidSearchRequestError);
  });

  it.each([
    "?sort=created_desc",
    "?limit=0",
    "?limit=25",
    `?q=${"x".repeat(121)}`,
    "?available=maybe",
    "?unknown=1",
    "?cursor=not-a-valid-cursor",
  ])("rejects invalid or unbounded input: %s", (query) => {
    expect(() => parseStorefrontSearchParams(new URL(`https://shop.example/${query}`).searchParams)).toThrow(
      InvalidSearchRequestError,
    );
  });
});

describe("searchStorefront", () => {
  it("delegates each opaque cursor page to one bounded catalog search call", async () => {
    const largeCatalog = Array.from({ length: 50 }, (_, index): StoreProduct => ({
      ...products[0],
      id: `product-${index.toString().padStart(3, "0")}`,
      handle: `product-${index}`,
      title: `Product ${index.toString().padStart(3, "0")}`,
    }));
    const listProductPage = vi.fn(async (_shopId: string, opts: { cursor?: string | null; limit: number }) => {
      const offset = opts.cursor ? Number(opts.cursor) : 0;
      const items = largeCatalog.slice(offset, offset + opts.limit);
      const next = offset + items.length;
      return { items, nextCursor: next < largeCatalog.length ? String(next) : null };
    });
    const searchProductPage = vi.fn(async (
      _shopId: string,
      opts: { after: { productId: string } | null },
    ) => {
      const offset = opts.after
        ? largeCatalog.findIndex((product) => product.id === opts.after!.productId) + 1
        : 0;
      return {
        items: largeCatalog.slice(offset, offset + 1),
        boundary: offset + 1 < largeCatalog.length
          ? { sortValue: largeCatalog[offset]!.title, productId: largeCatalog[offset]!.id }
          : null,
        facets: { categories: [], tags: [], collections: [] },
        total: largeCatalog.length,
        hasNextPage: offset + 1 < largeCatalog.length,
      };
    });
    const boundedCatalog = {
      searchProductPage,
      listProductPage,
      async listProducts() { return []; },
      async getProduct() { return null; },
      async listCollections() { return []; },
    };
    const input = parseStorefrontSearchParams(
      new URL("https://shop.example/?sort=title_asc&limit=1").searchParams,
    );

    const first = await searchStorefront("shop-a", input, boundedCatalog);
    const second = await searchStorefront("shop-a", { ...input, cursor: first.nextCursor }, boundedCatalog);

    expect(first.items.map((item) => item.id)).toEqual(["product-000"]);
    expect(second.items.map((item) => item.id)).toEqual(["product-001"]);
    expect(searchProductPage).toHaveBeenCalledTimes(2);
    expect(listProductPage).not.toHaveBeenCalled();
  });

  it("returns every active product exactly once across catalog pages", async () => {
    const merchant = storefrontProofContext();
    const ids = merchant.products.map(({ id }) => id);
    const allProducts = merchant.products.map((product): StoreProduct => ({
      id: product.id,
      handle: product.handle,
      title: product.title,
      description: `Complete merchant description for ${product.title}`,
      images: product.images.map((image) => ({ url: `https://cdn.example/${image.assetKey}.webp`, alt: product.title })),
      variants: [{ id: `${product.id}-variant`, sku: null, title: "Default", priceCents: product.priceMin, currency: product.currency, available: product.availability !== "sold_out" }],
      collections: ["proof-collection"],
    }));
    const pagedCatalog = {
      async searchProductPage(_shopId: string, opts: Parameters<typeof searchProductPageInMemory>[1]) {
        return searchProductPageInMemory(allProducts, opts);
      },
      async listProductPage(_shopId: string, opts: { cursor?: string | null; limit: number }) {
        const offset = opts.cursor ? Number(opts.cursor) : 0;
        const items = allProducts.slice(offset, offset + opts.limit);
        const next = offset + items.length;
        return { items, nextCursor: next < allProducts.length ? String(next) : null };
      },
      async listProducts() { return allProducts.slice(0, 24); },
      async getProduct() { return null; },
      async listCollections() { return []; },
    };
    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const page = await searchStorefront("shop-a", {
        query: "", collection: null, category: null, tag: null, available: null,
        sort: "relevance", cursor, limit: 24,
      }, pagedCatalog);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen.slice().sort()).toEqual(ids.slice().sort());
    expect(new Set(seen).size).toBe(61);
  });

  it("returns a capped projection and capped facets without exposing the scanned catalog", async () => {
    const input = parseStorefrontSearchParams(new URL("https://shop.example/?limit=2").searchParams);
    const result = await searchStorefront("shop-a", input);

    expect(catalog.searchProductPage).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).not.toHaveProperty("description");
    expect(result.total).toBe(3);
    expect(result.facets.categories).toEqual([
      { value: "Beauty", count: 2 },
      { value: "Wellness", count: 1 },
    ]);
    expect(result.facets.tags.length).toBeLessThanOrEqual(20);
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  it("derives fact choices and filtered results from live merchant facts", async () => {
    const factual = [
      { ...products[0], facts: normalizeProductFacts([{ kind: "material", value: "Walnut" }]) },
      { ...products[1], facts: normalizeProductFacts([{ kind: "material", value: "Clay" }]) },
      products[2],
    ];
    catalog.listProducts.mockResolvedValue(factual);
    const input = parseStorefrontSearchParams(new URL("https://shop.example/?fact.material=Walnut").searchParams);
    const result = await searchStorefront("shop-a", input);
    expect(result.items.map(({ id }) => id)).toEqual(["p-1"]);
    expect(result.facets.facts).toEqual({ material: ["Clay", "Walnut"] });
    expect(catalog.listProducts).toHaveBeenCalledWith("shop-a", { limit: 250 });
  });

  it("filters, sorts, and paginates through a shop/query-bound opaque cursor", async () => {
    const firstInput = parseStorefrontSearchParams(
      new URL("https://shop.example/?collection=skin&sort=price_desc&limit=1").searchParams,
    );
    const first = await searchStorefront("shop-a", firstInput);
    expect(first.items.map((item) => item.handle)).toEqual(["night-cream"]);

    const secondInput = { ...firstInput, cursor: first.nextCursor };
    const second = await searchStorefront("shop-a", secondInput);
    expect(second.items.map((item) => item.handle)).toEqual(["cloud-cleanser"]);

    await expect(searchStorefront("shop-b", secondInput)).rejects.toBeInstanceOf(InvalidSearchRequestError);
    await expect(searchStorefront("shop-a", { ...secondInput, query: "changed" })).rejects.toBeInstanceOf(
      InvalidSearchRequestError,
    );
  });

  it("keeps pagination stable when a product is inserted before the cursor", async () => {
    const input = parseStorefrontSearchParams(new URL("https://shop.example/?sort=title_asc&limit=1").searchParams);
    const first = await searchStorefront("shop-a", input);
    expect(first.items.map((item) => item.handle)).toEqual(["cloud-cleanser"]);

    catalog.searchProductPage.mockImplementation(async (_shopId, opts) => searchProductPageInMemory(
      [{ ...products[0], id: "p-0", handle: "alpha", title: "Alpha" }, ...products],
      opts,
    ));
    const second = await searchStorefront("shop-a", { ...input, cursor: first.nextCursor });
    expect(second.items.map((item) => item.handle)).toEqual(["night-cream"]);
  });

  it("signs the snapshot boundary returned by the catalog instead of a mutated product value", async () => {
    const input = parseStorefrontSearchParams(new URL("https://shop.example/?sort=title_asc&limit=1").searchParams);
    catalog.searchProductPage
      .mockResolvedValueOnce({
        items: [{ ...products[0], title: "Zulu after snapshot" }],
        facets: { categories: [], tags: [], collections: [] },
        total: 2,
        hasNextPage: true,
        boundary: { sortValue: "Cloud Cleanser", productId: "p-1" },
      })
      .mockResolvedValueOnce({
        items: [products[1]],
        facets: { categories: [], tags: [], collections: [] },
        total: 2,
        hasNextPage: false,
        boundary: null,
      });

    const first = await searchStorefront("shop-a", input);
    await searchStorefront("shop-a", { ...input, cursor: first.nextCursor });

    expect(catalog.searchProductPage.mock.calls[1]?.[1]).toMatchObject({
      after: { sortValue: "Cloud Cleanser", productId: "p-1" },
    });
  });

  it("fails closed when a continuing catalog page omits its snapshot boundary", async () => {
    catalog.searchProductPage.mockResolvedValueOnce({
      items: [products[0]],
      facets: { categories: [], tags: [], collections: [] },
      total: 2,
      hasNextPage: true,
    });
    const input = parseStorefrontSearchParams(new URL("https://shop.example/?sort=title_asc&limit=1").searchParams);

    await expect(searchStorefront("shop-a", input)).rejects.toThrow("invalid storefront catalog search page");
  });

  it("uses product ID as the cursor tie-break for equal titles", async () => {
    const tied = ["p-c", "p-a", "p-b"].map((id) => ({
      ...products[0], id, handle: id, title: "Same title",
    }));
    catalog.searchProductPage.mockImplementation(async (_shopId, opts) => searchProductPageInMemory(tied, opts));
    const input = parseStorefrontSearchParams(new URL("https://shop.example/?sort=title_asc&limit=1").searchParams);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await searchStorefront("shop-a", { ...input, cursor });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(["p-a", "p-b", "p-c"]);
    expect(new Set(seen).size).toBe(3);
  });

  it("uses product ID as the cursor tie-break for equal prices", async () => {
    const tied = ["p-c", "p-a", "p-b"].map((id) => ({
      ...products[0], id, handle: id, title: id,
      variants: [{ ...products[0].variants[0], id: `variant-${id}`, priceCents: 1200 }],
    }));
    catalog.searchProductPage.mockImplementation(async (_shopId, opts) => searchProductPageInMemory(tied, opts));
    const input = parseStorefrontSearchParams(new URL("https://shop.example/?sort=price_asc&limit=1").searchParams);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await searchStorefront("shop-a", { ...input, cursor });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(["p-a", "p-b", "p-c"]);
    expect(new Set(seen).size).toBe(3);
  });

  it("uses live variant availability and prices in the public projection", async () => {
    const input = parseStorefrontSearchParams(
      new URL("https://shop.example/?available=true&sort=price_asc").searchParams,
    );
    const result = await searchStorefront("shop-a", input);
    expect(result.items.map((item) => [item.handle, item.priceCents, item.available])).toEqual([
      ["tea-tonic", 900, true],
      ["cloud-cleanser", 2400, true],
    ]);
  });

  it("projects the cheapest sellable variant instead of an unpriced unavailable variant", async () => {
    catalog.searchProductPage.mockImplementation(async (_shopId, opts) => searchProductPageInMemory([{
      ...products[0],
      variants: [
        { id: "v-unpriced", sku: null, title: "Draft", priceCents: 0, currency: "USD", available: false, hasPrice: false },
        { id: "v-live", sku: null, title: "Live", priceCents: 2500, currency: "USD", available: true, hasPrice: true },
      ],
    }], opts));

    const input = parseStorefrontSearchParams(new URL("https://shop.example/?sort=price_asc").searchParams);
    const result = await searchStorefront("shop-a", input);

    expect(result.items[0]).toMatchObject({
      variantId: "v-live",
      priceCents: 2500,
      available: true,
    });
  });

  it("projects a missing-only price as null instead of a free-looking zero", async () => {
    catalog.searchProductPage.mockImplementation(async (_shopId, opts) => searchProductPageInMemory([{
      ...products[0],
      variants: [
        { id: "v-unpriced", sku: null, title: "Draft", priceCents: 0, currency: "USD", available: false, hasPrice: false },
      ],
    }], opts));

    const input = parseStorefrontSearchParams(new URL("https://shop.example/?sort=price_asc").searchParams);
    const result = await searchStorefront("shop-a", input);

    expect(result.items[0]).toMatchObject({
      variantId: "v-unpriced",
      priceCents: null,
      available: false,
    });
  });

  it.each([
    ["price_asc", ["cheap", "expensive", "missing"]],
    ["price_desc", ["expensive", "cheap", "missing"]],
  ] as const)("keeps missing prices last across every %s cursor page", async (sort, expected) => {
    const pricedAndMissing: StoreProduct[] = [
      {
        ...products[0], id: "p-cheap", handle: "cheap", title: "Cheap",
        variants: [{ ...products[0].variants[0], id: "v-cheap", priceCents: 100 }],
      },
      {
        ...products[0], id: "p-expensive", handle: "expensive", title: "Expensive",
        variants: [{ ...products[0].variants[0], id: "v-expensive", priceCents: 900 }],
      },
      {
        ...products[0], id: "p-missing", handle: "missing", title: "Missing",
        variants: [{
          ...products[0].variants[0], id: "v-missing", priceCents: 0,
          available: false, hasPrice: false,
        }],
      },
    ];
    catalog.searchProductPage.mockImplementation(async (_shopId, opts) =>
      searchProductPageInMemory(pricedAndMissing, opts));
    const input = parseStorefrontSearchParams(new URL(`https://shop.example/?sort=${sort}&limit=1`).searchParams);
    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const page = await searchStorefront("shop-a", { ...input, cursor });
      seen.push(...page.items.map((item) => item.handle));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(expected);
  });

  it("caps internal presentation descriptions at 500 Unicode code points", async () => {
    const description = `${"🙂".repeat(500)}tail`;
    catalog.searchProductPage.mockImplementation(async (_shopId, opts) =>
      searchProductPageInMemory([{ ...products[0], description }], opts));

    const result = await searchStorefront(
      "shop-a",
      parseStorefrontSearchParams(new URL("https://shop.example/?limit=1").searchParams),
    );

    expect([...result.presentationProducts[0]!.description]).toHaveLength(500);
    expect(result.presentationProducts[0]!.description.endsWith("tail")).toBe(false);
  });

  it("combines case-insensitive facet values because selecting either casing matches both products", () => {
    const page = searchProductPageInMemory([
      { ...products[0], category: "Beauty", tags: ["Sale", "sale"], collections: ["Skin", "skin"] },
      { ...products[1], category: "beauty", tags: ["sale"], collections: ["skin"] },
    ], {
      query: "", collection: null, category: null, tag: null, available: null,
      sort: "title_asc", limit: 24, after: null,
    });

    expect(page.facets).toEqual({
      categories: [{ value: "Beauty", count: 2 }],
      tags: [{ value: "Sale", count: 2 }],
      collections: [{ value: "Skin", count: 2 }],
    });
  });

  it.each([
    ["daily wash", ["cloud-cleanser"]],
    ["wellness", ["tea-tonic"]],
    ["vegan", ["cloud-cleanser", "tea-tonic"]],
  ])("matches description/category/tag text without a title-only database prefilter: %s", async (query, handles) => {
    const input = parseStorefrontSearchParams(new URL(`https://shop.example/?q=${encodeURIComponent(query)}`).searchParams);
    const result = await searchStorefront("shop-a", input);
    expect(catalog.searchProductPage).toHaveBeenCalledTimes(1);
    expect(result.items.map((item) => item.handle)).toEqual(handles);
  });
});
