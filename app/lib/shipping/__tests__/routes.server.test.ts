import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorldCityRow } from "../city-centroids.server";
import type { DestinationOrderRow } from "../destination-aggregation";

interface QueryCall {
  table: string;
  select?: string;
  eq: Array<[string, unknown]>;
  gte: Array<[string, unknown]>;
}

const supabase = vi.hoisted(() => {
  const calls: QueryCall[] = [];
  const rowsByTable: Record<string, unknown> = {};

  function from(table: string) {
    const call: QueryCall = { table, eq: [], gte: [] };
    calls.push(call);
    const response = () => ({ data: rowsByTable[table] ?? null, error: null });
    const query = {
      select(columns: string) {
        call.select = columns;
        return query;
      },
      eq(column: string, value: unknown) {
        call.eq.push([column, value]);
        return query;
      },
      gte(column: string, value: unknown) {
        call.gte.push([column, value]);
        return query;
      },
      maybeSingle() {
        return Promise.resolve(response());
      },
      then<TResult1 = unknown, TResult2 = never>(
        onFulfilled?: ((value: ReturnType<typeof response>) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve(response()).then(onFulfilled, onRejected);
      },
    };
    return query;
  }

  return { calls, rowsByTable, getSupabase: vi.fn(() => ({ from })) };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: supabase.getSupabase }));

const cityRows: WorldCityRow[] = [
  {
    city: "Toronto",
    city_ascii: "Toronto",
    lat: "43.6532",
    lng: "-79.3832",
    country: "Canada",
    iso2: "CA",
    iso3: "CAN",
    admin_name: "Ontario",
    population: "2794356",
  },
  {
    city: "Vancouver",
    city_ascii: "Vancouver",
    lat: "49.2827",
    lng: "-123.1207",
    country: "Canada",
    iso2: "CA",
    iso3: "CAN",
    admin_name: "British Columbia",
    population: "662248",
  },
  {
    city: "London",
    city_ascii: "London",
    lat: "51.5072",
    lng: "-0.1276",
    country: "United Kingdom",
    iso2: "GB",
    iso3: "GBR",
    admin_name: "London",
    population: "8982000",
  },
];

const origin = { city: "Toronto", state: "Ontario", country: "CA" };

beforeEach(() => {
  supabase.calls.length = 0;
  for (const table of Object.keys(supabase.rowsByTable)) delete supabase.rowsByTable[table];
  supabase.getSupabase.mockClear();
});

describe("buildShippingRoutes", () => {
  it("aggregates same-city orders and returns only privacy-safe city clusters", async () => {
    const { buildShippingRoutes } = await import("../routes.server");
    const rows: DestinationOrderRow[] = [
      { customer_city: " Toronto ", customer_region: "ON", customer_country: "CA" },
      { customer_city: "toronto", customer_region: "on", customer_country: "ca" },
      { customer_city: "London", customer_region: "London", customer_country: "GB" },
    ];

    const result = buildShippingRoutes(origin, rows, cityRows);

    expect(result.origin).toMatchObject({ city: "Toronto", region: "Ontario", country: "CA" });
    expect(result.destinations).toHaveLength(2);
    expect(result.destinations[0]).toMatchObject({ city: "Toronto", orderCount: 2 });
    expect(result.mappedOrderCount).toBe(3);
    expect(result.unmappedOrderCount).toBe(0);
    expect(result.hasInternationalDestinations).toBe(true);

    const serialized = JSON.stringify(result);
    for (const key of ["street", "street1", "zip", "buyer", "buyerId", "order", "orderId", "email", "phone"]) {
      expect(serialized).not.toContain(`"${key}":`);
    }
  });

  it("returns only the top 60 destinations while counting every resolvable order", async () => {
    const { buildShippingRoutes } = await import("../routes.server");
    const generatedCities: WorldCityRow[] = Array.from({ length: 61 }, (_, index) => ({
      city: `City ${index}`,
      city_ascii: `City ${index}`,
      lat: String(40 + index / 100),
      lng: String(-100 + index / 100),
      country: "Canada",
      iso2: "CA",
      iso3: "CAN",
      admin_name: "Ontario",
      population: String(10_000 - index),
    }));
    const rows: DestinationOrderRow[] = generatedCities.map((city) => ({
      customer_city: city.city,
      customer_region: city.admin_name,
      customer_country: city.iso2,
    }));

    const result = buildShippingRoutes(origin, rows, [...cityRows, ...generatedCities]);

    expect(result.destinations).toHaveLength(60);
    expect(result.mappedOrderCount).toBe(61);
    expect(result.unmappedOrderCount).toBe(0);
  });

  it("counts incomplete and unresolved destination rows as unmapped", async () => {
    const { buildShippingRoutes } = await import("../routes.server");
    const rows: DestinationOrderRow[] = [
      { customer_city: "Vancouver", customer_region: "BC", customer_country: "CA" },
      { customer_city: null, customer_region: "ON", customer_country: "CA" },
      { customer_city: "Unknown City", customer_region: "ON", customer_country: "CA" },
    ];

    const result = buildShippingRoutes(origin, rows, cityRows);

    expect(result.mappedOrderCount).toBe(1);
    expect(result.unmappedOrderCount).toBe(2);
  });

  it("treats CA, US, and MX as North America but flags GB", async () => {
    const { buildShippingRoutes } = await import("../routes.server");
    const northAmericanRows: WorldCityRow[] = [
      ...cityRows,
      {
        city: "Seattle",
        city_ascii: "Seattle",
        lat: "47.6062",
        lng: "-122.3321",
        country: "United States",
        iso2: "US",
        iso3: "USA",
        admin_name: "Washington",
      },
      {
        city: "Monterrey",
        city_ascii: "Monterrey",
        lat: "25.6866",
        lng: "-100.3161",
        country: "Mexico",
        iso2: "MX",
        iso3: "MEX",
        admin_name: "Nuevo Leon",
      },
    ];
    const naOrders: DestinationOrderRow[] = [
      { customer_city: "Toronto", customer_region: "ON", customer_country: "CA" },
      { customer_city: "Seattle", customer_region: "WA", customer_country: "US" },
      { customer_city: "Monterrey", customer_region: "Nuevo Leon", customer_country: "MX" },
    ];

    expect(buildShippingRoutes(origin, naOrders, northAmericanRows).hasInternationalDestinations).toBe(false);
    expect(
      buildShippingRoutes(
        origin,
        [...naOrders, { customer_city: "London", customer_region: "London", customer_country: "GB" }],
        northAmericanRows,
      ).hasInternationalDestinations,
    ).toBe(true);
  });

  it("returns a null origin and no routes when the origin cannot be resolved", async () => {
    const { buildShippingRoutes } = await import("../routes.server");

    const result = buildShippingRoutes(
      { city: "Unknown Origin", state: "", country: "CA" },
      [{ customer_city: "Toronto", customer_region: "ON", customer_country: "CA" }],
      cityRows,
    );

    expect(result.origin).toBeNull();
    expect(result.destinations).toEqual([]);
  });
});

describe("loadShippingRoutes30d", () => {
  it("reads only privacy-safe 30-day order fields scoped to the requested shop", async () => {
    supabase.rowsByTable.shop_origin = null;
    supabase.rowsByTable.order_fact = [];
    const { loadShippingRoutes30d } = await import("../routes.server");

    await loadShippingRoutes30d("shop-123", new Date("2026-07-13T12:00:00.000Z"));

    expect(supabase.calls).toEqual([
      {
        table: "shop_origin",
        select: "city, state, country",
        eq: [["shop_id", "shop-123"]],
        gte: [],
      },
      {
        table: "order_fact",
        select: "customer_city, customer_region, customer_country",
        eq: [["shop_id", "shop-123"]],
        gte: [["created_at_source", "2026-06-13T12:00:00.000Z"]],
      },
    ]);
  });
});
