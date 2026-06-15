import { describe, it, expect } from "vitest";
import { splitOrderShipCost } from "../split";

describe("splitOrderShipCost", () => {
  it("splits by weight share and sums to the order cost", () => {
    const m = splitOrderShipCost(1000, [
      { lineId: "x", grams: 100, quantity: 1 },
      { lineId: "y", grams: 300, quantity: 1 },
    ]);
    expect(m.get("y")!).toBe(750);
    expect(m.get("x")!).toBe(250);
    expect([...m.values()].reduce((s, v) => s + v, 0)).toBe(1000);
  });
  it("falls back to quantity when weights missing", () => {
    const m = splitOrderShipCost(900, [
      { lineId: "x", grams: null, quantity: 1 },
      { lineId: "y", grams: null, quantity: 2 },
    ]);
    expect(m.get("y")!).toBe(600);
    expect(m.get("x")!).toBe(300);
  });
});
