// Weather-merchandising wiring in ownedCatalog.listProducts: a shop whose active
// location sits in a region_weather row floats products matching that weather
// condition to the top. shopWeatherCondition memoizes per shopId in-process, so
// each case below uses a DISTINCT shopId to avoid one test's cached condition
// leaking into another.

import { describe, it, expect, vi, beforeEach } from "vitest";

let tableRows: Record<string, unknown[]> = {};
let tableSingle: Record<string, unknown> = {};

function builder(table: string) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  Object.assign(b, {
    select: chain,
    eq: chain,
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
  signMediaPaths: vi.fn(async (paths: string[]) => new Map(paths.map((p) => [p, `signed:${p}`]))),
}));

beforeEach(() => {
  tableRows = { variant_dim: [], product_media: [], product_collection: [] };
  tableSingle = {};
});

describe("ownedCatalog.listProducts — weather merchandising", () => {
  it("floats a storm-affinity product above a neutral product for a storm-region shop", async () => {
    tableRows.product_dim = [
      { id: "p-mug", handle: "mug", title: "Mug", description: "", category: "Mugs", tags: [] },
      { id: "p-umbrella", handle: "umbrella", title: "Umbrella", description: "", category: "Umbrellas", tags: [] },
    ];
    tableSingle.location_dim = { region: "us-east" };
    tableSingle.region_weather = { condition: "storm" };

    const { ownedCatalog } = await import("../catalog.owned.server");
    const out = await ownedCatalog.listProducts("shop-weather-storm");

    expect(out.map((p) => p.id)).toEqual(["p-umbrella", "p-mug"]);
  });

  it("leaves order unchanged when there is no region_weather row for the shop's region", async () => {
    tableRows.product_dim = [
      { id: "p-mug", handle: "mug", title: "Mug", description: "", category: "Mugs", tags: [] },
      { id: "p-umbrella", handle: "umbrella", title: "Umbrella", description: "", category: "Umbrellas", tags: [] },
    ];
    tableSingle.location_dim = { region: "us-west" };
    tableSingle.region_weather = null; // no cached forecast for this region yet

    const { ownedCatalog } = await import("../catalog.owned.server");
    const out = await ownedCatalog.listProducts("shop-weather-no-row");

    expect(out.map((p) => p.id)).toEqual(["p-mug", "p-umbrella"]);
  });

  it("leaves order unchanged under a storm condition when weather_merchandising is off", async () => {
    tableRows.product_dim = [
      { id: "p-mug", handle: "mug", title: "Mug", description: "", category: "Mugs", tags: [] },
      { id: "p-umbrella", handle: "umbrella", title: "Umbrella", description: "", category: "Umbrellas", tags: [] },
    ];
    // getSeoSettings only reads the DB for a real (uuid) shop_id — use a
    // distinct uuid so this case's off-toggle doesn't collide with the
    // module-level weather-condition memo used by the other cases.
    tableSingle.seo_settings = { weather_merchandising: false };
    tableSingle.location_dim = { region: "us-east" };
    tableSingle.region_weather = { condition: "storm" };

    const { ownedCatalog } = await import("../catalog.owned.server");
    const out = await ownedCatalog.listProducts("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    expect(out.map((p) => p.id)).toEqual(["p-mug", "p-umbrella"]);
  });
});
