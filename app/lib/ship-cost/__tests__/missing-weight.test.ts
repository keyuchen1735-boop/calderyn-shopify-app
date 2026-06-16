import { describe, it, expect } from "vitest";
import { missingWeightPct } from "../missing-weight";

describe("missingWeightPct", () => {
  it("returns the rounded percentage of orders missing weight", () => {
    expect(missingWeightPct([{ gramsSum: 100 }, { gramsSum: null }, { gramsSum: 0 }, { gramsSum: 50 }])).toBe(50);
  });
  it("treats null and 0 grams as missing", () => {
    expect(missingWeightPct([{ gramsSum: 0 }, { gramsSum: null }])).toBe(100);
  });
  it("returns 0 for an empty set (no orders, nothing degraded)", () => {
    expect(missingWeightPct([])).toBe(0);
  });
  it("returns 0 when all orders have weight", () => {
    expect(missingWeightPct([{ gramsSum: 10 }, { gramsSum: 20 }])).toBe(0);
  });
});
