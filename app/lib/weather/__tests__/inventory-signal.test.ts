import { describe, it, expect } from "vitest";
import { inventoryDraft } from "../inventory-signal";
import type { SkuDemandViewRow } from "../../inventory-demand";

const row = (over: Partial<SkuDemandViewRow> = {}): SkuDemandViewRow => ({
  sku_id: "sku1", main_demand_region: "us-east",
  demand_units_30d: 60, daily_demand: 2, demand_share: 1, stock_in_region: 3,
  dest_location_external_id: "gid://Location/1", dest_location_name: "NJ",
  src_location_external_id: "gid://Location/2", src_location_name: "CA",
  src_available: 50, inventory_item_id: "gid://InventoryItem/9",
  locations_detail: null, ...over,
});

describe("inventoryDraft", () => {
  it("emits a transfer draft when the short region has favorable weather", () => {
    const d = inventoryDraft(row(), new Map([["us-east", 0.6]]));
    expect(d).not.toBeNull();
    expect(d!.evidence.inventory_item_id).toBe("gid://InventoryItem/9");
    expect(d!.evidence.from_location_id).toBe("gid://Location/2");
    expect(d!.evidence.to_location_id).toBe("gid://Location/1");
    expect(d!.evidence.recommended_delta).toBeGreaterThan(0);
    expect(d!.entityRef.sku_id).toBe("sku1");
  });
  it("returns null when weather in the short region is mild (below floor)", () => {
    expect(inventoryDraft(row(), new Map([["us-east", 0.1]]))).toBeNull();
  });
  it("returns null when there is no transfer to make", () => {
    expect(inventoryDraft(row({ src_available: 0 }), new Map([["us-east", 0.9]]))).toBeNull();
  });
  it("returns null when the demand region is not a known weather region", () => {
    expect(inventoryDraft(row({ main_demand_region: "unknown" }), new Map())).toBeNull();
  });
});
