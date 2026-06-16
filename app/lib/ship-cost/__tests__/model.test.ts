import { describe, it, expect } from "vitest";

import { modelOrderShipCost, DEFAULT_SHIP_RATE_PER_KG_CENTS } from "../model";

describe("modelOrderShipCost", () => {
  it("returns null when weight is missing (null) so the resolver falls through", () => {
    expect(modelOrderShipCost(null, 1)).toBeNull();
  });

  it("returns null for zero or negative weight (no estimate from missing data)", () => {
    expect(modelOrderShipCost(0, 1)).toBeNull();
    expect(modelOrderShipCost(-50, 1)).toBeNull();
  });

  it("estimates rate × weight(kg) × zone multiplier", () => {
    // 1000 g = 1 kg, domestic (×1), default rate
    expect(modelOrderShipCost(1000, 1)).toBe(DEFAULT_SHIP_RATE_PER_KG_CENTS);
    // 500 g = 0.5 kg
    expect(modelOrderShipCost(500, 1)).toBe(Math.round(DEFAULT_SHIP_RATE_PER_KG_CENTS * 0.5));
  });

  it("scales by the destination zone multiplier", () => {
    // 2 kg, continental (×1.6)
    expect(modelOrderShipCost(2000, 1.6)).toBe(
      Math.round(DEFAULT_SHIP_RATE_PER_KG_CENTS * 2 * 1.6),
    );
  });

  it("honors an explicit per-kg rate override", () => {
    expect(modelOrderShipCost(1000, 1, 800)).toBe(800);
  });
});
