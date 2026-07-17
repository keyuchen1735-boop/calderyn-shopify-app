// The owned StorefrontCatalog runs on a PUBLIC, unauthenticated surface with no
// Postgres RLS, so these tests pin the tenancy-critical behavior: every read is
// scoped by shop_id, only `active` products are exposed, availability is derived
// from the Slice-2 inventory ledger (falling back to the editor's static
// inventory_on_hand for ledger-less variants), and images come through signed URLs.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Records the .eq() filters applied to each table so we can assert scoping.
const eqCalls: Record<string, Array<[string, unknown]>> = {};
const ilikeCalls: Record<string, Array<[string, string]>> = {};
const orCalls: Record<string, string[]> = {};
const rangeCalls: Record<string, Array<[number, number]>> = {};
const inCalls: Record<string, Array<[string, unknown[]]>> = {};
// Canned rows per table for a query that resolves to a list.
let tableRows: Record<string, unknown[]> = {};
// Canned single-row result per table (for maybeSingle()).
let tableSingle: Record<string, unknown> = {};
let tableCount: Record<string, number> = {};

function builder(table: string) {
  const b: Record<string, unknown> = {};
  let requestedRange: [number, number] | null = null;
  let requestedIn: [string, unknown[]] | null = null;
  const chain = () => b;
  Object.assign(b, {
    select: chain,
    eq: (col: string, val: unknown) => {
      (eqCalls[table] ??= []).push([col, val]);
      return b;
    },
    ilike: (col: string, val: string) => {
      (ilikeCalls[table] ??= []).push([col, val]);
      return b;
    },
    or: (value: string) => {
      (orCalls[table] ??= []).push(value);
      return b;
    },
    in: (col: string, values: unknown[]) => {
      requestedIn = [col, values];
      (inCalls[table] ??= []).push([col, values]);
      return b;
    },
    order: chain,
    limit: chain,
    range: (from: number, to: number) => {
      requestedRange = [from, to];
      (rangeCalls[table] ??= []).push([from, to]);
      return b;
    },
    maybeSingle: () => Promise.resolve({ data: tableSingle[table] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => {
      const rows = requestedIn && table === "collection_dim"
        ? (tableRows[table] ?? []).filter((row) => requestedIn![1].includes((row as Record<string, unknown>)[requestedIn![0]]))
        : tableRows[table] ?? [];
      const [from, to] = requestedRange ?? [0, 999];
      return Promise.resolve({
        data: rows.slice(from, to + 1), error: null, count: tableCount[table] ?? null,
      }).then(resolve);
    },
  });
  return b;
}

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: (t: string) => builder(t) }) }));
vi.mock("~/lib/catalog/sign-media.server", () => ({
  signMediaPaths: vi.fn(async (paths: string[]) => new Map(paths.map((p) => [p, `signed:${p}`]))),
}));

beforeEach(() => {
  for (const k of Object.keys(eqCalls)) delete eqCalls[k];
  for (const k of Object.keys(ilikeCalls)) delete ilikeCalls[k];
  for (const k of Object.keys(orCalls)) delete orCalls[k];
  for (const k of Object.keys(rangeCalls)) delete rangeCalls[k];
  for (const k of Object.keys(inCalls)) delete inCalls[k];
  tableRows = {};
  tableSingle = {};
  tableCount = {};
});

describe("ownedCatalog.listProductPage", () => {
  it("caps public pages and continues from the stable title-plus-id cursor", async () => {
    tableRows = {
      product_dim: Array.from({ length: 25 }, (_, index) => ({
        id: `product-${index.toString().padStart(2, "0")}`,
        handle: `product-${index}`,
        title: `Product ${index.toString().padStart(2, "0")}`,
        description: `Description ${index}`,
      })),
      variant_dim: [], product_media: [], product_collection: [], product_option: [],
    };
    const { ownedCatalog } = await import("../catalog.owned.server");
    const first = await ownedCatalog.listProductPage("shop-1", { limit: 99 });
    expect(first.items).toHaveLength(24);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(eqCalls.product_dim).toEqual(expect.arrayContaining([["shop_id", "shop-1"], ["status", "active"]]));

    await ownedCatalog.listProductPage("shop-1", { cursor: first.nextCursor, limit: 24 });
    expect(orCalls.product_dim.at(-1)).toContain("title.gt.");
    expect(orCalls.product_dim.at(-1)).toContain("id.gt.");
  });

  it("assembles child rows beyond the PostgREST page boundary", async () => {
    const collectionId = (index: number) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
    tableRows = {
      product_dim: [{ id: "p1", handle: "complete", title: "Complete", description: "All child rows" }],
      variant_dim: Array.from({ length: 1001 }, (_, index) => ({
        id: `v${index}`, product_id: "p1", sku: `SKU-${index}`, title: `Variant ${index}`,
        retail_price_cents: 1000 + index, currency: "USD", inventory_tracked: false, inventory_on_hand: 0, position: index,
      })),
      product_media: Array.from({ length: 1001 }, (_, index) => ({
        product_id: "p1", storage_path: `shop-1/p1/${index}.png`, alt: `Image ${index}`, position: index, is_primary: index === 0,
      })),
      product_collection: Array.from({ length: 1001 }, (_, index) => ({ product_id: "p1", collection_id: collectionId(index) })),
      product_option: Array.from({ length: 1001 }, (_, index) => ({
        product_id: "p1", name: `Option ${index}`, position: index, product_option_value: [],
      })),
      collection_dim: Array.from({ length: 1001 }, (_, index) => ({ id: collectionId(index), handle: `collection-${index}` })),
      inventory_balance: [],
    };
    const { ownedCatalog } = await import("../catalog.owned.server");

    const page = await ownedCatalog.listProductPage("shop-1", { limit: 24 });
    const product = page.items[0]!;

    expect(product.variants).toHaveLength(1001);
    expect(product.variants.at(-1)).toMatchObject({ title: "Variant 1000", priceCents: 2000, available: true });
    expect(product.images).toHaveLength(1001);
    expect(product.images.at(-1)?.url).toBe("signed:shop-1/p1/1000.png");
    expect(product.collections).toHaveLength(1001);
    expect(product.collections.at(-1)).toBe("collection-1000");
    expect(product.options).toHaveLength(1001);
    expect(product.options?.at(-1)?.name).toBe("Option 1000");
    for (const table of ["variant_dim", "product_media", "product_collection", "product_option"]) {
      expect(rangeCalls[table]).toEqual([[0, 999], [1000, 1999]]);
    }
    const collectionIdFilters = inCalls.collection_dim.map(([, values]) => values);
    expect(collectionIdFilters).toHaveLength(6);
    expect(collectionIdFilters.every((values) => values.length <= 200)).toBe(true);
    expect(collectionIdFilters.flat()).toHaveLength(1001);
    expect(rangeCalls.collection_dim).toEqual(collectionIdFilters.map(() => [0, 999]));
    expect(eqCalls.collection_dim.filter(([column, value]) => column === "shop_id" && value === "shop-1")).toHaveLength(6);
  });
});

describe("ownedCatalog.listProducts", () => {
  it("escapes SQL wildcard characters so public search treats them literally", async () => {
    tableRows = { product_dim: [], variant_dim: [], product_media: [], product_collection: [] };
    const { ownedCatalog } = await import("../catalog.owned.server");
    await ownedCatalog.listProducts("shop-1", { query: String.raw`50%_off\\sale` });
    expect(ilikeCalls.product_dim).toContainEqual(["title", String.raw`%50\%\_off\\\\sale%`]);
  });
  it("scopes products to the shop and to active status", async () => {
    tableRows = { product_dim: [], variant_dim: [], product_media: [], product_collection: [] };
    const { ownedCatalog } = await import("../catalog.owned.server");
    await ownedCatalog.listProducts("shop-1");
    expect(eqCalls.product_dim).toContainEqual(["shop_id", "shop-1"]);
    expect(eqCalls.product_dim).toContainEqual(["status", "active"]);
  });

  it("derives availability from tracked + on-hand, signs images, and resolves collection handles", async () => {
    tableRows = {
      product_dim: [{ id: "p1", handle: "tee", title: "Tee", description: "Soft" }],
      variant_dim: [
        { id: "v1", product_id: "p1", sku: "S", title: "S", retail_price_cents: 1999, currency: "USD", inventory_tracked: true, inventory_on_hand: 0, position: 0 },
        { id: "v2", product_id: "p1", sku: "M", title: "M", retail_price_cents: 1999, currency: "USD", inventory_tracked: true, inventory_on_hand: 3, position: 1 },
        { id: "v3", product_id: "p1", sku: "L", title: "L", retail_price_cents: 1999, currency: "USD", inventory_tracked: false, inventory_on_hand: 0, position: 2 },
      ],
      product_media: [
        { product_id: "p1", storage_path: "shop-1/p1/b.png", alt: null, position: 1, is_primary: false },
        { product_id: "p1", storage_path: "shop-1/p1/a.png", alt: "main", position: 0, is_primary: true },
      ],
      product_collection: [{ product_id: "p1", collection_id: "c1" }],
      collection_dim: [{ id: "c1", handle: "apparel" }],
    };
    const { ownedCatalog } = await import("../catalog.owned.server");
    const out = await ownedCatalog.listProducts("shop-1");
    expect(out).toHaveLength(1);
    const p = out[0];
    expect(p.variants.map((v) => v.available)).toEqual([false, true, true]); // tracked-0, tracked-3, untracked
    expect(p.images[0].url).toBe("signed:shop-1/p1/a.png"); // primary leads
    expect(p.collections).toEqual(["apparel"]);
    // collection-handle lookup is shop-scoped
    expect(eqCalls.collection_dim).toContainEqual(["shop_id", "shop-1"]);
  });

  it("renders a promoted mirror image from its external_url (hotlink), never signed", async () => {
    tableRows = {
      product_dim: [{ id: "p1", handle: "tee", title: "Tee", description: null }],
      variant_dim: [
        { id: "v1", product_id: "p1", sku: "S", title: "S", retail_price_cents: 1999, currency: "USD", inventory_tracked: false, inventory_on_hand: 0, position: 0 },
      ],
      // Promoted from the Shopify mirror: external_url set, storage_path null.
      product_media: [
        { product_id: "p1", storage_path: null, external_url: "https://cdn.shopify.com/x.jpg", alt: "Tee", position: 0, is_primary: true },
      ],
      product_collection: [],
    };
    const { ownedCatalog } = await import("../catalog.owned.server");
    const { signMediaPaths } = await import("~/lib/catalog/sign-media.server");
    const out = await ownedCatalog.listProducts("shop-1");
    expect(out[0].images).toEqual([{ url: "https://cdn.shopify.com/x.jpg", alt: "Tee" }]);
    // The external hotlink is used directly — the null storage_path is never signed.
    expect(signMediaPaths).toHaveBeenCalledWith([]);
  });

  it("derives availability from the inventory ledger when balance rows exist (import/checkout truth)", async () => {
    tableRows = {
      product_dim: [{ id: "p1", handle: "board", title: "Board", description: "" }],
      variant_dim: [
        // Imported variant: editor snapshot says 0, but the ledger holds real stock.
        { id: "v1", product_id: "p1", sku: "A", title: "A", retail_price_cents: 9900, currency: "USD", inventory_tracked: true, inventory_on_hand: 0, position: 0 },
        // Fully reserved: on_hand exists but reservations consume it -> not sellable.
        { id: "v2", product_id: "p1", sku: "B", title: "B", retail_price_cents: 9900, currency: "USD", inventory_tracked: true, inventory_on_hand: 9, position: 1 },
      ],
      inventory_balance: [
        // v1 stock spread across two locations: 50 + 50 = 100 sellable. `available`
        // is the DB's generated on_hand - reserved - unavailable column.
        { variant_id: "v1", available: 50 },
        { variant_id: "v1", available: 50 },
        // v2: reservations/unavailable consume everything.
        { variant_id: "v2", available: 0 },
      ],
      product_media: [],
      product_collection: [],
    };
    const { ownedCatalog } = await import("../catalog.owned.server");
    const out = await ownedCatalog.listProducts("shop-1");
    expect(out[0].variants.map((v) => v.available)).toEqual([true, false]);
    // The ledger read is tenant-scoped like every other query on this surface.
    expect(eqCalls.inventory_balance).toContainEqual(["shop_id", "shop-1"]);
  });

  it("falls back to the editor's inventory_on_hand for a variant the ledger has never seen", async () => {
    tableRows = {
      product_dim: [{ id: "p1", handle: "tee", title: "Tee", description: "" }],
      variant_dim: [
        { id: "v1", product_id: "p1", sku: "S", title: "S", retail_price_cents: 1999, currency: "USD", inventory_tracked: true, inventory_on_hand: 4, position: 0 },
      ],
      inventory_balance: [],
      product_media: [],
      product_collection: [],
    };
    const { ownedCatalog } = await import("../catalog.owned.server");
    const out = await ownedCatalog.listProducts("shop-1");
    expect(out[0].variants[0].available).toBe(true);
  });

  it("never sells a price-less variant: null retail_price_cents -> not available", async () => {
    tableRows = {
      product_dim: [{ id: "p1", handle: "tee", title: "Tee", description: "" }],
      variant_dim: [
        { id: "v1", product_id: "p1", sku: "S", title: "S", retail_price_cents: null, currency: "USD", inventory_tracked: false, inventory_on_hand: 9, position: 0 },
      ],
      product_media: [],
      product_collection: [],
    };
    const { ownedCatalog } = await import("../catalog.owned.server");
    const out = await ownedCatalog.listProducts("shop-1");
    // Untracked would normally be "always available"; a missing price overrides that.
    expect(out[0].variants[0].available).toBe(false);
    expect(out[0].variants[0].priceCents).toBe(0);
  });

  it("returns [] for an unknown collection handle without touching products", async () => {
    tableSingle = {}; // collection_dim.maybeSingle -> null
    const { ownedCatalog } = await import("../catalog.owned.server");
    const out = await ownedCatalog.listProducts("shop-1", { collection: "ghost" });
    expect(out).toEqual([]);
    expect(eqCalls.collection_dim).toContainEqual(["handle", "ghost"]);
  });
});

describe("ownedCatalog.getProduct", () => {
  it("returns null for an unknown handle", async () => {
    tableSingle = {}; // product_dim.maybeSingle -> null
    const { ownedCatalog } = await import("../catalog.owned.server");
    expect(await ownedCatalog.getProduct("shop-1", "ghost")).toBeNull();
  });

  it("scopes by shop, handle, and active status", async () => {
    tableSingle = { product_dim: { id: "p1", handle: "tee", title: "Tee", description: "" } };
    tableRows = { variant_dim: [], product_media: [], product_collection: [] };
    const { ownedCatalog } = await import("../catalog.owned.server");
    const p = await ownedCatalog.getProduct("shop-1", "tee");
    expect(p?.handle).toBe("tee");
    expect(eqCalls.product_dim).toContainEqual(["shop_id", "shop-1"]);
    expect(eqCalls.product_dim).toContainEqual(["handle", "tee"]);
    expect(eqCalls.product_dim).toContainEqual(["status", "active"]);
  });
});

describe("ownedCatalog.getVariantById", () => {
  it("looks up the variant and active owning product directly within the resolved shop", async () => {
    tableSingle = {
      variant_dim: {
        id: "v1", product_id: "p1", sku: "S", title: "Small", retail_price_cents: 1999,
        currency: "USD", inventory_tracked: false, inventory_on_hand: 0,
      },
      product_dim: { id: "p1", handle: "tee", title: "Tee", description: "Soft" },
    };
    const { ownedCatalog } = await import("../catalog.owned.server");
    const resolved = await ownedCatalog.getVariantById?.("shop-1", "v1");
    expect(resolved?.product.title).toBe("Tee");
    expect(resolved?.variant.priceCents).toBe(1999);
    expect(eqCalls.variant_dim).toContainEqual(["shop_id", "shop-1"]);
    expect(eqCalls.variant_dim).toContainEqual(["id", "v1"]);
    expect(eqCalls.product_dim).toContainEqual(["shop_id", "shop-1"]);
    expect(eqCalls.product_dim).toContainEqual(["status", "active"]);
  });
});

describe("ownedCatalog.listCollections", () => {
  it("returns shop-scoped {handle,title}", async () => {
    tableRows = { collection_dim: [{ handle: "apparel", title: "Apparel" }] };
    const { ownedCatalog } = await import("../catalog.owned.server");
    const out = await ownedCatalog.listCollections("shop-1");
    expect(out).toEqual([{ handle: "apparel", title: "Apparel" }]);
    expect(eqCalls.collection_dim).toContainEqual(["shop_id", "shop-1"]);
  });
});

describe("ownedCatalog.getCollection", () => {
  it("performs one shop-scoped handle lookup and returns an accurate active-product count", async () => {
    tableSingle = {
      collection_dim: { id: "c1", handle: "apparel", title: "Apparel", description: "Wear it" },
    };
    tableCount = { product_collection: 37 };
    const { ownedCatalog } = await import("../catalog.owned.server");
    const collection = await ownedCatalog.getCollection!("shop-1", "apparel");
    expect(collection).toEqual({
      id: "c1", handle: "apparel", title: "Apparel", description: "Wear it", productCount: 37,
    });
    expect(eqCalls.collection_dim).toContainEqual(["shop_id", "shop-1"]);
    expect(eqCalls.collection_dim).toContainEqual(["handle", "apparel"]);
    expect(eqCalls.product_collection).toContainEqual(["collection_id", "c1"]);
    expect(eqCalls.product_collection).toContainEqual(["product_dim.shop_id", "shop-1"]);
    expect(eqCalls.product_collection).toContainEqual(["product_dim.status", "active"]);
  });
});
