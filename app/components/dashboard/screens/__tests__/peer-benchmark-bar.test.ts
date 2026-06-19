import { describe, expect, it } from "vitest";
import { benchmarkBarGeometry } from "../PeerBenchmarks";
import type { PeerKpi } from "~/lib/benchmarks/types";

function kpi(overrides: Partial<PeerKpi> = {}): PeerKpi {
  return {
    metric_key: "aov",
    label: "Average order value",
    unit: "USD",
    your_value: 300,
    p25: 200,
    p50: 300,
    p75: 400,
    n: 7,
    percentile: 50,
    available: true,
    ...overrides,
  };
}

describe("benchmarkBarGeometry", () => {
  it("returns null when the KPI is not available", () => {
    expect(benchmarkBarGeometry(kpi({ available: false }))).toBeNull();
  });

  it("returns null when the peer band is missing", () => {
    expect(benchmarkBarGeometry(kpi({ p25: null }))).toBeNull();
    expect(benchmarkBarGeometry(kpi({ p75: null }))).toBeNull();
  });

  it("places the IQR band inside the track and the median between its edges", () => {
    const g = benchmarkBarGeometry(kpi())!;
    expect(g).not.toBeNull();
    // band is padded in from both edges, never flush
    expect(g.bandStartPct).toBeGreaterThan(0);
    expect(g.bandStartPct + g.bandWidthPct).toBeLessThan(100);
    // symmetric p25/p50/p75 with you==median -> median + you sit mid-band
    expect(g.medianPct).toBeCloseTo(50, 1);
    expect(g.youPct).toBeCloseTo(50, 1);
    expect(g.youPct!).toBeGreaterThan(g.bandStartPct);
    expect(g.youPct!).toBeLessThan(g.bandStartPct + g.bandWidthPct);
  });

  it("places the you-marker to the right of the band when you beat the p75 peer", () => {
    const g = benchmarkBarGeometry(kpi({ your_value: 500 }))!;
    expect(g.youPct!).toBeGreaterThan(g.bandStartPct + g.bandWidthPct);
    expect(g.youPct!).toBeLessThanOrEqual(100);
  });

  it("places the you-marker to the left of the band when you trail the p25 peer", () => {
    const g = benchmarkBarGeometry(kpi({ your_value: 100 }))!;
    expect(g.youPct!).toBeLessThan(g.bandStartPct);
    expect(g.youPct!).toBeGreaterThanOrEqual(0);
  });

  it("omits the you-marker but keeps the band when the shop has no own value", () => {
    const g = benchmarkBarGeometry(kpi({ your_value: null, percentile: null }))!;
    expect(g.youPct).toBeNull();
    expect(g.medianPct).toBeCloseTo(50, 1);
    expect(g.bandWidthPct).toBeGreaterThan(0);
  });

  it("clamps an extreme outlier to the track bounds", () => {
    const g = benchmarkBarGeometry(kpi({ your_value: 100000 }))!;
    expect(g.youPct!).toBeLessThanOrEqual(100);
    expect(g.youPct!).toBeGreaterThanOrEqual(0);
    expect(g.bandStartPct).toBeGreaterThanOrEqual(0);
  });

  it("keeps a visible band when all peer quartiles are equal", () => {
    const g = benchmarkBarGeometry(kpi({ p25: 50, p50: 50, p75: 50, your_value: 50 }))!;
    expect(g).not.toBeNull();
    expect(Number.isFinite(g.bandStartPct)).toBe(true);
    expect(Number.isFinite(g.youPct!)).toBe(true);
  });
});
