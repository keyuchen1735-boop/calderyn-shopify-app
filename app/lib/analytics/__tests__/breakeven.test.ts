import { describe, it, expect } from "vitest";
import { computeBreakEven, DEFAULT_MARGIN, COVERAGE_THRESHOLD } from "../breakeven";

const line = (price: number, qty: number, cost: number | null) => ({
  price_cents: price,
  quantity: qty,
  unit_cost_cents: cost,
});

describe("computeBreakEven", () => {
  it("computes margin and break-even from full-coverage lines", () => {
    // revenue 10000, cogs 5000 -> margin 0.5 -> break-even 2.0
    const r = computeBreakEven({
      lines: [line(10000, 1, 5000)],
      override: null,
      defaultMargin: DEFAULT_MARGIN,
      coverageThreshold: COVERAGE_THRESHOLD,
    });
    expect(r.margin).toBeCloseTo(0.5, 5);
    expect(r.breakEvenRoas).toBeCloseTo(2.0, 5);
    expect(r.confidence).toBe("ok");
    expect(r.coverage).toBeCloseTo(1, 5);
  });

  it("excludes (does not zero) lines with unknown cost", () => {
    // known: rev 10000 cogs 5000; unknown: rev 10000 -> coverage 0.5 < 0.70 -> default
    const r = computeBreakEven({
      lines: [line(10000, 1, 5000), line(10000, 1, null)],
      override: null,
      defaultMargin: DEFAULT_MARGIN,
      coverageThreshold: COVERAGE_THRESHOLD,
    });
    expect(r.coverage).toBeCloseTo(0.5, 5);
    expect(r.confidence).toBe("default");
    expect(r.margin).toBeCloseTo(DEFAULT_MARGIN, 5);
  });

  it("keeps computed margin when coverage meets the threshold", () => {
    // known rev 9000 (cost 4500), unknown rev 1000 -> coverage 0.9 >= 0.70
    const r = computeBreakEven({
      lines: [line(9000, 1, 4500), line(1000, 1, null)],
      override: null,
      defaultMargin: DEFAULT_MARGIN,
      coverageThreshold: COVERAGE_THRESHOLD,
    });
    expect(r.confidence).toBe("ok");
    expect(r.margin).toBeCloseTo(0.5, 5);
  });

  it("honors a manual override above computed/default", () => {
    const r = computeBreakEven({
      lines: [line(10000, 1, 5000)],
      override: 0.25,
      defaultMargin: DEFAULT_MARGIN,
      coverageThreshold: COVERAGE_THRESHOLD,
    });
    expect(r.confidence).toBe("override");
    expect(r.margin).toBeCloseTo(0.25, 5);
    expect(r.breakEvenRoas).toBeCloseTo(4.0, 5);
  });

  it("falls back to default when there is no revenue", () => {
    const r = computeBreakEven({
      lines: [],
      override: null,
      defaultMargin: DEFAULT_MARGIN,
      coverageThreshold: COVERAGE_THRESHOLD,
    });
    expect(r.confidence).toBe("default");
    expect(r.coverage).toBe(0);
  });

  it("falls back to default when computed margin is non-positive", () => {
    // cost exceeds price -> margin <= 0 is meaningless for break-even
    const r = computeBreakEven({
      lines: [line(5000, 1, 6000)],
      override: null,
      defaultMargin: DEFAULT_MARGIN,
      coverageThreshold: COVERAGE_THRESHOLD,
    });
    expect(r.confidence).toBe("default");
    expect(r.margin).toBeCloseTo(DEFAULT_MARGIN, 5);
  });
});
