import { describe, it, expect } from "vitest";
import {
  demandFromRow,
  suggestedTransferFromRow,
  locationsDetailFromRow,
  formatDemandUnits,
  projectedStockoutDate,
  formatStockoutDate,
  affinityFromRow,
  returnRateLevel,
  type SkuDemandViewRow,
} from "../inventory-demand";

const ROW: SkuDemandViewRow = {
  sku_id: "sku-1",
  main_demand_region: "CA",
  demand_units_30d: 300,
  daily_demand: "10",
  demand_share: "0.75",
  stock_in_region: 5,
  dest_location_external_id: "gid://shopify/Location/2",
  dest_location_name: "LA Warehouse",
  src_location_external_id: "gid://shopify/Location/9",
  src_location_name: "NY Warehouse",
  src_available: 80,
  inventory_item_id: "gid://shopify/InventoryItem/1",
  locations_detail: [
    {
      external_id: "gid://shopify/Location/9",
      name: "NY Warehouse",
      region: "NY",
      available: 80,
      active: true,
    },
    {
      external_id: "gid://shopify/Location/2",
      name: "LA Warehouse",
      region: "CA",
      available: 5,
      active: false,
    },
  ],
};

describe("demandFromRow", () => {
  it("maps the view row into the SKU demand shape", () => {
    expect(demandFromRow(ROW)).toEqual({
      region: "CA",
      units_30d: 300,
      share: 0.75,
      stock_in_region: 5,
    });
  });
});

describe("suggestedTransferFromRow", () => {
  it("suggests min(weekly shortfall, source availability)", () => {
    // weekly demand 70, in-region 5 => shortfall 65; src has 80 => delta 65.
    expect(suggestedTransferFromRow(ROW)).toEqual({
      inventory_item_id: "gid://shopify/InventoryItem/1",
      from_location_id: "gid://shopify/Location/9",
      from_location_name: "NY Warehouse",
      to_location_id: "gid://shopify/Location/2",
      to_location_name: "LA Warehouse",
      recommended_delta: 65,
    });
  });

  it("caps the delta at source availability", () => {
    expect(
      suggestedTransferFromRow({ ...ROW, src_available: 40 })?.recommended_delta,
    ).toBe(40);
  });

  it("returns null when the region already holds a week of demand", () => {
    expect(suggestedTransferFromRow({ ...ROW, stock_in_region: 70 })).toBeNull();
  });

  it("returns null without a viable source, destination, or inventory item", () => {
    expect(suggestedTransferFromRow({ ...ROW, src_location_external_id: null })).toBeNull();
    expect(suggestedTransferFromRow({ ...ROW, dest_location_external_id: null })).toBeNull();
    expect(suggestedTransferFromRow({ ...ROW, inventory_item_id: null })).toBeNull();
  });

  it("returns null when source and destination are the same location", () => {
    expect(
      suggestedTransferFromRow({
        ...ROW,
        src_location_external_id: ROW.dest_location_external_id,
      }),
    ).toBeNull();
  });

  it("returns null when there is no demand", () => {
    expect(suggestedTransferFromRow({ ...ROW, daily_demand: "0" })).toBeNull();
  });

  it("returns null when daily_demand is malformed (NaN must not reach the mutation)", () => {
    expect(
      suggestedTransferFromRow({ ...ROW, daily_demand: "not-a-number" as unknown as string }),
    ).toBeNull();
  });

  it("returns null when src_available is 0", () => {
    expect(suggestedTransferFromRow({ ...ROW, src_available: 0 })).toBeNull();
  });

  it("returns null when src_available is negative", () => {
    expect(suggestedTransferFromRow({ ...ROW, src_available: -5 })).toBeNull();
  });
});

describe("affinityFromRow", () => {
  it("maps a co-purchase view row into the SkuAffinityItem shape", () => {
    expect(
      affinityFromRow({
        co_sku_id: "sku-co",
        co_title: "Summit Logo Tee — M",
        co_sku: "TEE-M",
        co_count: "65",
        share: "0.108",
      }),
    ).toEqual({
      sku_id: "sku-co",
      title: "Summit Logo Tee — M",
      co_count: 65,
      share: 0.108,
    });
  });

  it("falls back to the sku code, then the id, when the title is missing", () => {
    expect(
      affinityFromRow({ co_sku_id: "sku-x", co_title: null, co_sku: "X-1", co_count: 3, share: 0.1 })
        .title,
    ).toBe("X-1");
    expect(
      affinityFromRow({ co_sku_id: "sku-y", co_title: null, co_sku: null, co_count: 1, share: 0.05 })
        .title,
    ).toBe("sku-y");
  });
});

describe("returnRateLevel", () => {
  it("flags a rate above 25% as critical", () => {
    expect(returnRateLevel(0.27)).toBe("critical");
    expect(returnRateLevel(1)).toBe("critical");
  });

  it("flags a rate above 10% (but not above 25%) as caution", () => {
    expect(returnRateLevel(0.11)).toBe("caution");
    expect(returnRateLevel(0.25)).toBe("caution");
  });

  it("returns null for a healthy rate at or below 10%", () => {
    expect(returnRateLevel(0.1)).toBeNull();
    expect(returnRateLevel(0.05)).toBeNull();
    expect(returnRateLevel(0)).toBeNull();
  });
});

describe("formatDemandUnits", () => {
  it("spells out the units and the trailing-30-day window (was the cryptic '10/30d')", () => {
    expect(formatDemandUnits(10)).toBe("10 units sold/30d");
  });

  it("uses the singular noun for exactly one unit", () => {
    expect(formatDemandUnits(1)).toBe("1 unit sold/30d");
  });

  it("renders zero demand with the plural noun", () => {
    expect(formatDemandUnits(0)).toBe("0 units sold/30d");
  });

  it("groups thousands so large run-rates stay readable", () => {
    expect(formatDemandUnits(1500)).toBe("1,500 units sold/30d");
  });
});

describe("projectedStockoutDate", () => {
  // A fixed clock so the UTC date math is deterministic across machines/TZ.
  const NOW = new Date("2026-06-16T00:00:00Z");

  it("returns null when velocity is zero (no sales → no meaningful date)", () => {
    expect(projectedStockoutDate(999, 0, NOW)).toBeNull();
  });

  it("returns null when velocity is negative", () => {
    expect(projectedStockoutDate(5, -1, NOW)).toBeNull();
  });

  it("returns null when velocity is NaN", () => {
    expect(projectedStockoutDate(5, Number.NaN, NOW)).toBeNull();
  });

  it("returns null when days of cover is non-finite (never an Invalid Date)", () => {
    expect(projectedStockoutDate(Number.POSITIVE_INFINITY, 10, NOW)).toBeNull();
    expect(projectedStockoutDate(Number.NaN, 10, NOW)).toBeNull();
  });

  it("projects whole days of cover onto the calendar (now + N days)", () => {
    expect(projectedStockoutDate(3, 10, NOW)).toBe("2026-06-19");
  });

  it("carries the fractional part of cover into the same calendar day", () => {
    // 3.2d from midnight = Jun 19 04:48 UTC → still Jun 19.
    expect(projectedStockoutDate(3.2, 10, NOW)).toBe("2026-06-19");
  });

  it("rolls the calendar date when the fraction crosses midnight UTC", () => {
    // 0.5d (12h) from 18:00 UTC = next day 06:00 UTC.
    expect(projectedStockoutDate(0.5, 10, new Date("2026-06-16T18:00:00Z"))).toBe(
      "2026-06-17",
    );
  });

  it("returns today's date for a selling SKU already at zero cover", () => {
    expect(projectedStockoutDate(0, 10, NOW)).toBe("2026-06-16");
  });

  it("projects an earlier date as cover falls", () => {
    const soon = projectedStockoutDate(2, 10, NOW);
    const later = projectedStockoutDate(20, 10, NOW);
    expect(soon).not.toBeNull();
    expect(later).not.toBeNull();
    expect(soon! < later!).toBe(true);
  });
});

describe("formatStockoutDate", () => {
  const NOW = new Date("2026-06-16T00:00:00Z");

  it("formats a same-year date as a short month + day (no year)", () => {
    expect(formatStockoutDate("2026-06-19", NOW)).toBe("Jun 19");
  });

  it("does not drop a leading-zero day", () => {
    expect(formatStockoutDate("2026-01-01", NOW)).toBe("Jan 1");
  });

  it("includes the year when the projection lands in a different year", () => {
    // A 999-day-cover SKU projects years out — the bare 'Mar 5' would mislead.
    expect(formatStockoutDate("2029-03-05", NOW)).toBe("Mar 5, 2029");
  });

  it("reads the calendar day from the ISO string in UTC (no off-by-one TZ shift)", () => {
    // Re-parsing '2026-06-01' through local time in a negative-offset TZ would
    // roll back to May 31; forcing UTC keeps it on Jun 1.
    expect(formatStockoutDate("2026-06-01", NOW)).toBe("Jun 1");
  });
});

describe("locationsDetailFromRow", () => {
  it("maps external_id to id and coerces numbers", () => {
    expect(locationsDetailFromRow(ROW)).toEqual([
      {
        id: "gid://shopify/Location/9",
        name: "NY Warehouse",
        region: "NY",
        available: 80,
        active: true,
      },
      {
        id: "gid://shopify/Location/2",
        name: "LA Warehouse",
        region: "CA",
        available: 5,
        active: false,
      },
    ]);
  });

  it("defaults active to true when absent (older payloads)", () => {
    const row = {
      ...ROW,
      locations_detail: [
        { external_id: "gid://shopify/Location/9", name: "NY Warehouse", region: "NY", available: 80 },
      ],
    };
    expect(locationsDetailFromRow(row)[0].active).toBe(true);
  });

  it("returns empty array when locations_detail is null", () => {
    expect(locationsDetailFromRow({ ...ROW, locations_detail: null })).toEqual([]);
  });

  it("coerces null available to 0", () => {
    const row = {
      ...ROW,
      locations_detail: [
        {
          external_id: "gid://shopify/Location/9",
          name: "NY Warehouse",
          region: "NY",
          available: null as unknown as number,
        },
      ],
    };
    expect(locationsDetailFromRow(row)[0].available).toBe(0);
  });
});
