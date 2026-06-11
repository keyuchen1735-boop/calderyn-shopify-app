import { describe, it, expect } from "vitest";
import {
  demandFromRow,
  suggestedTransferFromRow,
  locationsDetailFromRow,
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
    { external_id: "gid://shopify/Location/9", name: "NY Warehouse", region: "NY", available: 80 },
    { external_id: "gid://shopify/Location/2", name: "LA Warehouse", region: "CA", available: 5 },
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
});

describe("locationsDetailFromRow", () => {
  it("maps external_id to id and coerces numbers", () => {
    expect(locationsDetailFromRow(ROW)).toEqual([
      { id: "gid://shopify/Location/9", name: "NY Warehouse", region: "NY", available: 80 },
      { id: "gid://shopify/Location/2", name: "LA Warehouse", region: "CA", available: 5 },
    ]);
  });

  it("returns empty array when locations_detail is null", () => {
    expect(locationsDetailFromRow({ ...ROW, locations_detail: null })).toEqual([]);
  });

  it("coerces string numbers in available", () => {
    const row = {
      ...ROW,
      locations_detail: [
        { external_id: "gid://shopify/Location/9", name: "NY Warehouse", region: "NY", available: 80 },
      ],
    };
    expect(locationsDetailFromRow(row)[0].available).toBe(80);
  });
});
