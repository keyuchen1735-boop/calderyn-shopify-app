import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreProduct } from "./catalog";

const catalog = vi.hoisted(() => ({ listProducts: vi.fn() }));

vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({ listProducts: catalog.listProducts }),
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
    });
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
  it("returns a capped projection and capped facets without exposing the scanned catalog", async () => {
    const input = parseStorefrontSearchParams(new URL("https://shop.example/?limit=2").searchParams);
    const result = await searchStorefront("shop-a", input);

    expect(catalog.listProducts).toHaveBeenCalledWith("shop-a", { limit: 250 });
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

  it.each([
    ["daily wash", ["cloud-cleanser"]],
    ["wellness", ["tea-tonic"]],
    ["vegan", ["cloud-cleanser", "tea-tonic"]],
  ])("matches description/category/tag text without a title-only database prefilter: %s", async (query, handles) => {
    const input = parseStorefrontSearchParams(new URL(`https://shop.example/?q=${encodeURIComponent(query)}`).searchParams);
    const result = await searchStorefront("shop-a", input);
    expect(catalog.listProducts).toHaveBeenCalledWith("shop-a", { limit: 250 });
    expect(result.items.map((item) => item.handle)).toEqual(handles);
  });
});
