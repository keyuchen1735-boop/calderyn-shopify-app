import { describe, expect, it } from "vitest";
import { deriveDone } from "./journey-derive";

const NONE = {
  productCount: 0, payoutsReady: false, originSet: false, rateCount: 0,
  storefrontPublished: false, testOrderCount: 0, realOrderCount: 0,
  autopilotEnabled: false, assistantConvoCount: 0,
};

describe("deriveDone", () => {
  it("fresh shop: only account", () => {
    expect([...deriveDone(NONE)]).toEqual(["account"]);
  });
  it("shipping needs origin AND at least one rate", () => {
    expect(deriveDone({ ...NONE, originSet: true }).has("shipping")).toBe(false);
    expect(deriveDone({ ...NONE, rateCount: 1 }).has("shipping")).toBe(false);
    expect(deriveDone({ ...NONE, originSet: true, rateCount: 1 }).has("shipping")).toBe(true);
  });
  it("orders split into test and real", () => {
    const d = deriveDone({ ...NONE, testOrderCount: 1 });
    expect(d.has("test_order")).toBe(true);
    expect(d.has("first_order")).toBe(false);
    const r = deriveDone({ ...NONE, realOrderCount: 2 });
    expect(r.has("first_order")).toBe(true);
    expect(r.has("test_order")).toBe(false);
  });
  it("full shop: all nine", () => {
    const d = deriveDone({
      productCount: 3, payoutsReady: true, originSet: true, rateCount: 2,
      storefrontPublished: true, testOrderCount: 1, realOrderCount: 5,
      autopilotEnabled: true, assistantConvoCount: 4,
    });
    expect(d.size).toBe(9);
  });
});
