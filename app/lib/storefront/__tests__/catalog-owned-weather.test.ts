// Weather-boosted merchandising on the owned catalog's listProducts: when the
// shop's active location resolves to a region with a clear (non-neutral)
// condition in region_weather, weather-relevant products float to the top of
// the results; when the condition resolves to neutral (no matching rows), the
// order is left exactly as-is. Mirrors the mocking style of
// catalog.owned.server.test.ts, extended with a `.not()` chain method and a
// per-table `maybeSingle` queue so the location_dim and region_weather reads
// (both resolved via maybeSingle) can be primed independently of the list-style
// tableRows/tableSingle used for product_dim etc.

import { describe, it, expect, vi, beforeEach } from "vitest";

const eqCalls: Record<string, Array<[string, unknown]>> = {};
let tableRows: Record<string, unknown[]> = {};
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
    not: chain,
    order: chain,
    limit: chain,
    range: chain,
    maybeSingle: () => Promise.resolve({ data: tableSingle[table] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: tableRows[table] ?? [], error: null }).then(resolve),
  });
  return b;
}

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: (t: string) => builder(t) }) }));
vi.mock("~/lib/catalog/sign-media.server", () => ({
  signMediaPaths: async (paths: string[]) => new Map(paths.map((p) => [p, `signed:${p}`])),
}));

beforeEach(() => {
  for (const k of Object.keys(eqCalls)) delete eqCalls[k];
  tableRows = {};
  tableSingle = {};
});

// Two products: a storm-affinity "Umbrellas" product and a neutral "Mugs"
// product, seeded alphabetically (Mugs before Umbrellas) so the default
// (no-boost) order is Mugs, Umbrellas — the reverse of what a storm boost
// should produce.
function seedProducts() {
  tableRows = {
    product_dim: [
      { id: "p-mugs", handle: "mugs", title: "Mugs", description: "", category: "Kitchen", tags: [] },
      { id: "p-umbrellas", handle: "umbrellas", title: "Umbrellas", description: "", category: "Umbrellas", tags: ["rain"] },
    ],
    variant_dim: [],
    product_media: [],
    product_collection: [],
  };
}

describe("ownedCatalog.listProducts weather boost", () => {
  it("floats a storm-affinity product above a neutral one when the shop's region is stormy", async () => {
    seedProducts();
    tableSingle = {
      location_dim: { region: "us-east" },
      region_weather: { condition: "storm" },
    };
    const { ownedCatalog } = await import("../catalog.owned.server");
    // Distinct shopId per case: shopWeatherCondition is memoized per shop, so
    // reusing one id would bleed a cached condition across cases.
    const out = await ownedCatalog.listProducts("shop-storm");
    expect(out.map((p) => p.handle)).toEqual(["umbrellas", "mugs"]);
    expect(eqCalls.location_dim).toContainEqual(["shop_id", "shop-storm"]);
    expect(eqCalls.location_dim).toContainEqual(["active", true]);
    expect(eqCalls.region_weather).toContainEqual(["region", "us-east"]);
  });

  it("leaves the alphabetical order unchanged when no region_weather row exists (neutral)", async () => {
    seedProducts();
    tableSingle = {
      location_dim: { region: "us-east" },
      // region_weather.maybeSingle() -> null (no row for this region)
    };
    const { ownedCatalog } = await import("../catalog.owned.server");
    const out = await ownedCatalog.listProducts("shop-neutral-norow");
    expect(out.map((p) => p.handle)).toEqual(["mugs", "umbrellas"]);
  });

  it("leaves the order unchanged when the shop has no active location (neutral)", async () => {
    seedProducts();
    tableSingle = {}; // location_dim.maybeSingle() -> null
    const { ownedCatalog } = await import("../catalog.owned.server");
    const out = await ownedCatalog.listProducts("shop-neutral-noloc");
    expect(out.map((p) => p.handle)).toEqual(["mugs", "umbrellas"]);
  });
});
