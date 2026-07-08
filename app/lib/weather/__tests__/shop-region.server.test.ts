// app/lib/weather/__tests__/shop-region.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

let tableSingle: Record<string, unknown> = {};
let throwOn: string | null = null;

function builder(table: string) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  Object.assign(b, {
    select: chain,
    eq: chain,
    not: chain,
    limit: chain,
    maybeSingle: () => {
      if (throwOn === table) throw new Error(`boom: ${table}`);
      return Promise.resolve({ data: tableSingle[table] ?? null, error: null });
    },
  });
  return b;
}

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: (t: string) => builder(t) }) }));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import { shopRegionCondition } from "../shop-region.server";

const SHOP = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  tableSingle = {};
  throwOn = null;
});

describe("shopRegionCondition", () => {
  it("returns the region and condition for a shop with an active location and a cached forecast", async () => {
    tableSingle.location_dim = { region: "us-east" };
    tableSingle.region_weather = { condition: "storm" };
    expect(await shopRegionCondition(SHOP)).toEqual({ region: "us-east", condition: "storm" });
  });

  it("returns null when the shop has no active location with a region", async () => {
    tableSingle.location_dim = null;
    expect(await shopRegionCondition(SHOP)).toBeNull();
  });

  it("returns null when there is no region_weather row for the region yet", async () => {
    tableSingle.location_dim = { region: "us-west" };
    tableSingle.region_weather = null;
    expect(await shopRegionCondition(SHOP)).toBeNull();
  });

  it("returns null when the stored condition is not a recognized value", async () => {
    tableSingle.location_dim = { region: "us-west" };
    tableSingle.region_weather = { condition: "hurricane" };
    expect(await shopRegionCondition(SHOP)).toBeNull();
  });

  it("returns null (fail-safe) when a query throws", async () => {
    throwOn = "location_dim";
    tableSingle.location_dim = { region: "us-east" };
    expect(await shopRegionCondition(SHOP)).toBeNull();
  });

  it("returns null for a non-uuid shopId without touching the DB", async () => {
    expect(await shopRegionCondition("demo-shop")).toBeNull();
  });
});
