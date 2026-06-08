import { describe, it, expect } from "vitest";
import { calibrate, ctrMultiplier, compositeScore, gradeFor } from "../calibrate.server";
import { DIMENSIONS, type MetricScore, type CalibrationInputs } from "../types";

function metricsAll(score: number): MetricScore[] {
  return DIMENSIONS.map((d) => ({ id: d.id, group: d.group, label: d.label, score, reasoning: "" }));
}

const fullHistory: CalibrationInputs = {
  accountBaselineCtr: 0.01,
  accountBaselineCpmCents: 1500,
  accountEngagementRate: 0.05,
  breakEvenRoas: 1.9,
  mappedSku: "HYD-SERUM-30ML",
  skuPriceCents: 4200,
  skuCvr: 0.021,
  topAdNames: ["Summer Bundle Drop", "Glow in 7 days"],
  historyAdCount: 23,
};

describe("ctrMultiplier", () => {
  it("returns ~1.0 for an average (50) creative", () => {
    expect(ctrMultiplier(metricsAll(50))).toBeCloseTo(1.0, 2);
  });
  it("is >1 for a strong creative and <1 for a weak one", () => {
    expect(ctrMultiplier(metricsAll(90))).toBeGreaterThan(1.3);
    expect(ctrMultiplier(metricsAll(20))).toBeLessThan(0.7);
  });
  it("clamps to the documented bounds", () => {
    expect(ctrMultiplier(metricsAll(100))).toBeLessThanOrEqual(2.5);
    expect(ctrMultiplier(metricsAll(0))).toBeGreaterThanOrEqual(0.3);
  });
});

describe("compositeScore + gradeFor", () => {
  it("rolls dimensions into 0..100 and grades", () => {
    expect(compositeScore(metricsAll(80))).toBeGreaterThanOrEqual(75);
    expect(gradeFor(80)).toBe("winning");
    expect(gradeFor(60)).toBe("okay");
    expect(gradeFor(40)).toBe("poor");
  });
});

describe("calibrate", () => {
  it("computes ROAS from SKU price, CTR and CVR with full history → high confidence", () => {
    const r = calibrate(metricsAll(70), fullHistory, 50000);
    expect(r.confidence).toBe("high");
    expect(r.outcomes.estimatedRoas).toBeGreaterThan(0);
    expect(r.outcomes.skuPriceCents).toBe(4200);
    expect(r.outcomes.breakEvenRoas).toBe(1.9);
    expect(r.outcomes.roasLow).toBeLessThan(r.outcomes.estimatedRoas);
    expect(r.outcomes.roasHigh).toBeGreaterThan(r.outcomes.estimatedRoas);
  });

  it("ROAS scales with the assumed spend's revenue correctly (more clicks at same CVR)", () => {
    const a = calibrate(metricsAll(70), fullHistory, 50000);
    const b = calibrate(metricsAll(70), fullHistory, 100000);
    expect(Math.abs(a.outcomes.estimatedRoas - b.outcomes.estimatedRoas)).toBeLessThan(0.01);
  });

  it("cold start (no SKU, no history) → low confidence + wide band using fallbacks", () => {
    const cold: CalibrationInputs = {
      accountBaselineCtr: 0.01, accountBaselineCpmCents: 1500, accountEngagementRate: 0.05,
      breakEvenRoas: 2.0, mappedSku: null, skuPriceCents: null, skuCvr: null,
      topAdNames: [], historyAdCount: 0,
    };
    const r = calibrate(metricsAll(60), cold, 50000);
    expect(r.confidence).toBe("low");
    expect(r.outcomes.mappedSku).toBeNull();
    expect(Number.isFinite(r.outcomes.estimatedRoas)).toBe(true);
    const fullBand = r.outcomes.roasHigh - r.outcomes.roasLow;
    const tight = calibrate(metricsAll(60), fullHistory, 50000);
    const tightBand = tight.outcomes.roasHigh - tight.outcomes.roasLow;
    expect(fullBand / r.outcomes.estimatedRoas).toBeGreaterThan(tightBand / tight.outcomes.estimatedRoas);
  });

  it("medium confidence for thin-but-present history", () => {
    const r = calibrate(metricsAll(60), { ...fullHistory, historyAdCount: 6 }, 50000);
    expect(r.confidence).toBe("medium");
  });

  it("a resolved SKU price alone earns medium even with no ad-count history (Plan 1 wiring)", () => {
    // Plan 1 has no real ad-count or CVR yet, so confidence must key off the real
    // SKU price grounding — otherwise it would be misleadingly stuck at "low".
    const r = calibrate(
      metricsAll(60),
      { ...fullHistory, historyAdCount: 0, skuCvr: null, skuPriceCents: 4200 },
      50000,
    );
    expect(r.confidence).toBe("medium");
  });

  it("stays low when neither ad-count nor a SKU price is available", () => {
    const r = calibrate(
      metricsAll(60),
      { ...fullHistory, historyAdCount: 0, skuCvr: null, skuPriceCents: null },
      50000,
    );
    expect(r.confidence).toBe("low");
  });
});
