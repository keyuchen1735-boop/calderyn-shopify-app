import { describe, it, expect } from "vitest";
import type { DetectorId, ActionKind } from "~/lib/types";

describe("ship-leak type registry", () => {
  it("free_shipping_leakage is a valid DetectorId", () => {
    const d: DetectorId = "free_shipping_leakage";
    expect(d).toBe("free_shipping_leakage");
  });
  it("the two free-ship actions are valid ActionKinds", () => {
    const a: ActionKind = "raise_free_ship_threshold";
    const b: ActionKind = "exclude_sku_free_ship";
    expect([a, b]).toEqual(["raise_free_ship_threshold", "exclude_sku_free_ship"]);
  });
});
