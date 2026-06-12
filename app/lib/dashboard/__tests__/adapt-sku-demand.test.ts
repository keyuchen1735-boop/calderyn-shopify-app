import { describe, it, expect } from "vitest";

import { adaptSku } from "../client";

const BASE = {
  id: "sku-1",
  title: "Widget",
  on_hand: 85,
  days_of_cover: 4,
  velocity: 10,
  locations: { NY: 80, LA: 5 },
  sources: [],
  demand: { region: "CA", units_30d: 300, share: 0.75, stock_in_region: 5 },
  suggested_transfer: {
    inventory_item_id: "gid://shopify/InventoryItem/1",
    from_location_id: "gid://shopify/Location/9",
    from_location_name: "NY",
    to_location_id: "gid://shopify/Location/2",
    to_location_name: "LA",
    recommended_delta: 65,
  },
  locations_detail: [
    { id: "gid://shopify/Location/9", name: "NY", region: "NY", available: 80 },
  ],
};

describe("adaptSku demand passthrough", () => {
  it("carries demand, suggestion, and location detail into the VM", () => {
    const vm = adaptSku(BASE as never);
    expect(vm.demand?.region).toBe("CA");
    expect(vm.suggested_transfer?.recommended_delta).toBe(65);
    expect(vm.locations_detail).toHaveLength(1);
  });

  it("defaults to null/empty when the API omits the fields (older payloads)", () => {
    const vm = adaptSku({
      ...BASE,
      demand: undefined,
      suggested_transfer: undefined,
      locations_detail: undefined,
    } as never);
    expect(vm.demand).toBeNull();
    expect(vm.suggested_transfer).toBeNull();
    expect(vm.locations_detail).toEqual([]);
  });
});
