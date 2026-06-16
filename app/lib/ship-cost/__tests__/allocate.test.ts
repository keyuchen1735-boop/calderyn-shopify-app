import { describe, it, expect } from "vitest";
import { allocatePeriodTotal, type AllocOrder } from "../allocate";

const o = (id: string, grams: number | null, itemCount: number, zm = 1): AllocOrder => ({
  orderId: id, grams, itemCount, zoneMultiplier: zm, fulfillmentCount: 1,
});

describe("allocatePeriodTotal", () => {
  it("sums exactly to the period total (no cents lost to rounding)", () => {
    const m = allocatePeriodTotal([o("a", 100, 1), o("b", 200, 1), o("c", 33, 1)], 10000);
    expect([...m.values()].reduce((s, v) => s + v, 0)).toBe(10000);
  });
  it("allocates by weight when grams present", () => {
    const m = allocatePeriodTotal([o("a", 100, 1), o("b", 300, 1)], 8000);
    expect(m.get("b")!).toBeGreaterThan(m.get("a")!); // heavier order pays more
  });
  it("falls back to item count when any order lacks grams", () => {
    const m = allocatePeriodTotal([o("a", null, 1), o("b", null, 3)], 8000);
    expect(m.get("b")!).toBe(6000);
    expect(m.get("a")!).toBe(2000);
  });
  it("zone multiplier scales the share", () => {
    const m = allocatePeriodTotal([o("a", 100, 1, 1), o("b", 100, 1, 3)], 8000);
    expect(m.get("b")!).toBe(6000);
  });
  it("empty orders returns empty map", () => {
    expect(allocatePeriodTotal([], 5000).size).toBe(0);
  });
});
