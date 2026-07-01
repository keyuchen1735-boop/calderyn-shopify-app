// The owned StorefrontCatalog runs on a PUBLIC, unauthenticated surface with no
// Postgres RLS, so these tests pin the tenancy-critical behavior: every read is
// scoped by shop_id, only `active` products are exposed, availability is derived
// from the static Slice-1 stock, and images come through signed URLs.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Records the .eq() filters applied to each table so we can assert scoping.
const eqCalls: Record<string, Array<[string, unknown]>> = {};
// Canned rows per table for a query that resolves to a list.
let tableRows: Record<string, unknown[]> = {};
// Canned single-row result per table (for maybeSingle()).
let tableSingle: Record<string, unknown> = {};

function builder(table: string) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  Object.assign(b, {
    select: chain,
    eq: (col: string, val: unknown) => {
      (eqCalls[table] ??= []).push([col, val]);
      return b;
    },
    in: chain,
    order: chain,
    limit: chain,
    maybeSingle: () => Promise.resolve({ data: tableSingle[table] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: tableRows[table] ?? [], error: null }).then(resolve),
  });
  return b;
}

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: (t: string) => builder(t) }) }));
vi.mock("~/lib/catalog/sign-media.server", () => ({
  signMediaPaths: vi.fn(async (paths: string[]) => new Map(paths.map((p) => [p, `signed:${p}`]))),
}));

beforeEach(() => {
  for (const k of Object.keys(eqCalls)) delete eqCalls[k];
  tableRows = {};
  tableSingle = {};
});

describe("ownedCatalog.listProducts", () => {
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

describe("ownedCatalog.listCollections", () => {
  it("returns shop-scoped {handle,title}", async () => {
    tableRows = { collection_dim: [{ handle: "apparel", title: "Apparel" }] };
    const { ownedCatalog } = await import("../catalog.owned.server");
    const out = await ownedCatalog.listCollections("shop-1");
    expect(out).toEqual([{ handle: "apparel", title: "Apparel" }]);
    expect(eqCalls.collection_dim).toContainEqual(["shop_id", "shop-1"]);
  });
});
