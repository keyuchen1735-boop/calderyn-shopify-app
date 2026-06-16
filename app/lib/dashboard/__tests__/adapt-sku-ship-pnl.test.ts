import { describe, it, expect } from "vitest";

import { adaptSku } from "../client";

const BASE = {
  id: "sku-1",
  title: "Widget",
  sku: "WGT-001",
  on_hand: 85,
  days_of_cover: 4,
  velocity: 10,
  locations: { NY: 80 },
  sources: [],
};

describe("adaptSku ship-P&L passthrough", () => {
  it("carries ship_pnl_cents into the VM", () => {
    const vm = adaptSku({ ...BASE, ship_pnl_cents: -21400 } as never);
    expect(vm.ship_pnl_cents).toBe(-21400);
  });

  it("defaults ship_pnl_cents to null when the API omits it (older payloads)", () => {
    const vm = adaptSku({ ...BASE, ship_pnl_cents: undefined } as never);
    expect(vm.ship_pnl_cents).toBeNull();
  });
});
