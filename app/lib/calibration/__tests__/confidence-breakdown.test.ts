import { describe, it, expect } from "vitest";
import { pairConfidenceBreakdown, pairConfidence } from "../confidence";

describe("pairConfidenceBreakdown", () => {
  it("returns three plain-language factors with 0-100 values and weights summing to 1", () => {
    const b = pairConfidenceBreakdown("campaign_below_breakeven", "pause_campaign", { alpha: 3, beta: 0 }, null);
    expect(b.factors).toHaveLength(3);
    expect(b.factors.map((f) => f.key)).toEqual(["detection", "historical", "reversibility"]);
    for (const f of b.factors) {
      expect(f.value).toBeGreaterThanOrEqual(0);
      expect(f.value).toBeLessThanOrEqual(100);
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.label).not.toMatch(/[—–]/); // no em/en dashes in merchant-facing labels
    }
    const weightSum = b.factors.reduce((s, f) => s + f.weight, 0);
    expect(weightSum).toBeCloseTo(1, 5);
  });

  it("its confidence equals pairConfidence for the same inputs (single source of truth)", () => {
    const ev = { alpha: 2, beta: 1 };
    const b = pairConfidenceBreakdown("campaign_below_breakeven", "pause_campaign", ev, null);
    expect(b.confidence).toBe(pairConfidence("campaign_below_breakeven", "pause_campaign", ev, null));
  });

  it("historical factor rises as clean approvals accumulate", () => {
    const low = pairConfidenceBreakdown("campaign_below_breakeven", "pause_campaign", { alpha: 0, beta: 0 }, null);
    const high = pairConfidenceBreakdown("campaign_below_breakeven", "pause_campaign", { alpha: 8, beta: 0 }, null);
    const lowHist = low.factors.find((f) => f.key === "historical")!.value;
    const highHist = high.factors.find((f) => f.key === "historical")!.value;
    expect(highHist).toBeGreaterThan(lowHist);
  });
});
