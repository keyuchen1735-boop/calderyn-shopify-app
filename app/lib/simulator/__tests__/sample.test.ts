// app/lib/simulator/__tests__/sample.test.ts
import { describe, it, expect } from "vitest";
import { sampleFunnel, mulberry32, seedFromString } from "../sample";
import { FUNNEL_STAGES, type BehaviorModel } from "../types";

const model: BehaviorModel = {
  storeSummary: "test store",
  shipping: { amount: 9.95, currency: "USD", estimated: false },
  archetypes: [
    {
      id: "a",
      name: "A",
      weight: 0.5,
      advance: {
        landed: 1, viewed_product: 1, added_to_cart: 1,
        started_checkout: 1, shipping_reveal: 0, bought: 1,
      },
      dropReason: { shipping_reveal: "too pricey" },
    },
    {
      id: "b",
      name: "B",
      weight: 0.5,
      advance: {
        landed: 1, viewed_product: 1, added_to_cart: 1,
        started_checkout: 1, shipping_reveal: 1, bought: 1,
      },
      dropReason: {},
    },
  ],
  findings: [
    { id: "f1", severity: "critical", title: "Shipping", stage: "shipping_reveal", personaIds: ["a"], fix: "free ship" },
  ],
};

describe("mulberry32", () => {
  it("is deterministic for a fixed seed", () => {
    const r1 = mulberry32(123);
    const r2 = mulberry32(123);
    expect(r1()).toBe(r2());
    expect(r1()).toBe(r2());
  });
});

describe("sampleFunnel", () => {
  it("is deterministic for the same (model, n, seed)", () => {
    const a = sampleFunnel(model, 1000, 42);
    const b = sampleFunnel(model, 1000, 42);
    expect(a).toEqual(b);
  });

  it("starts with everyone landed and never increases down the funnel", () => {
    const res = sampleFunnel(model, 1000, 42);
    expect(res.stages[0].reached).toBe(1000);
    for (let i = 1; i < res.stages.length; i++) {
      expect(res.stages[i].reached).toBeLessThanOrEqual(res.stages[i - 1].reached);
    }
    expect(res.stages).toHaveLength(FUNNEL_STAGES.length);
  });

  it("respects probabilities at scale: ~half bounce at shipping (archetype A)", () => {
    const res = sampleFunnel(model, 1000, 42);
    // A (50% of pop) always bounces at shipping_reveal; B always buys.
    expect(res.bought).toBeGreaterThan(420);
    expect(res.bought).toBeLessThan(580);
    const leak = res.biggestLeak!;
    expect(leak.stageId).toBe("shipping_reveal");
    expect(res.findingCounts.f1).toBeGreaterThan(420);
  });

  it("seedFromString is stable and unsigned", () => {
    expect(seedFromString("run-123")).toBe(seedFromString("run-123"));
    expect(seedFromString("run-123")).toBeGreaterThanOrEqual(0);
  });
});
