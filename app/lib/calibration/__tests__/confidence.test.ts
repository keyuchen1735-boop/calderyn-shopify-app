import { describe, it, expect } from "vitest";
import {
  pairPrior, historical, confidence, calibrationPct, smooth,
  actionTier, reversibilityFactor, NO_BRAINER, HAS_EXECUTOR,
  pairConfidence, DETECTION_COLD,
} from "../confidence";
import { DETECTOR_TO_ACTIONS } from "../../labels";

describe("pairPrior", () => {
  it("applies the no-brainer bonus and clamps at 0.95", () => {
    expect(pairPrior("reversible", true, null)).toBeCloseTo(0.715, 3); // 0.55*1.30
    expect(pairPrior("reversible", false, null)).toBeCloseTo(0.55, 3);
    expect(pairPrior("irreversible", true, null)).toBeCloseTo(0.26, 3); // 0.20*1.30
    expect(pairPrior("reversible", true, 0.99)).toBe(0.95); // peer wins but clamped
  });
  it("prefers a positive peer p50 over the static seed", () => {
    expect(pairPrior("irreversible", false, 0.8)).toBeCloseTo(0.8, 3);
    expect(pairPrior("irreversible", false, 0)).toBeCloseTo(0.20, 3); // 0 ignored -> seed
  });
});

describe("historical", () => {
  it("returns the prior when there is no real evidence (no divide-by-zero)", () => {
    expect(historical(0, 0, 0.715, 8)).toBeCloseTo(0.715, 3);
  });
  it("moves toward 1 with approvals", () => {
    expect(historical(10, 0, 0.5, 8)).toBeGreaterThan(0.75);
  });
  it("moves toward 0 with rejections", () => {
    expect(historical(0, 10, 0.5, 8)).toBeLessThan(0.25);
  });
});

describe("confidence", () => {
  it("the canonical cold-start no-brainer lands ~74", () => {
    const c = confidence({
      guardrailVeto: 1, detection: 0.6, historical: 0.715, reversibility: 1.0,
    });
    expect(c).toBe(74);
  });
  it("a zero guardrail veto forces 0 regardless of other factors", () => {
    expect(confidence({ guardrailVeto: 0, detection: 1, historical: 1, reversibility: 1 })).toBe(0);
  });
  it("never returns NaN", () => {
    expect(confidence({ guardrailVeto: 1, detection: NaN, historical: 0.5, reversibility: 1 })).toBe(0);
  });
});

describe("calibrationPct", () => {
  it("is a weight-normalized average", () => {
    // 2 pairs: conf 80 weight 3, conf 0 weight 1 -> (240+0)/4 = 60
    expect(calibrationPct([{ conf: 80, weight: 3 }, { conf: 0, weight: 1 }])).toBe(60);
  });
  it("returns 0 when there is no weight", () => {
    expect(calibrationPct([])).toBe(0);
    expect(calibrationPct([{ conf: 50, weight: 0 }])).toBe(0);
  });
});

describe("smooth", () => {
  it("returns raw on first run (no prior display)", () => {
    expect(smooth(40, null)).toBe(40);
  });
  it("clamps the daily move to +/-5", () => {
    expect(smooth(100, 50)).toBe(55); // EWMA would be 85, clamped to +5
    expect(smooth(0, 50)).toBe(45);   // clamped to -5
  });
  it("holds steady inside the dead-band", () => {
    expect(smooth(51, 50)).toBe(50); // EWMA ~50.3, |delta|<1 -> hold
  });
});

describe("pairConfidence", () => {
  it("matches the canonical no-brainer at cold start (~74)", () => {
    // sku_stockout_vs_spend:pause_campaign is a NO_BRAINER, reversible, has executor
    expect(pairConfidence("sku_stockout_vs_spend", "pause_campaign", { alpha: 0, beta: 0 }, null)).toBe(74);
  });
  it("is 0 for a no-executor action (guardrail veto)", () => {
    expect(pairConfidence("margin_erosion", "snooze_alert", { alpha: 0, beta: 0 }, null)).toBe(0);
  });
  it("rises as approvals accrue", () => {
    const cold = pairConfidence("campaign_below_breakeven", "pause_campaign", { alpha: 0, beta: 0 }, null);
    const warm = pairConfidence("campaign_below_breakeven", "pause_campaign", { alpha: 10, beta: 0 }, null);
    expect(warm).toBeGreaterThan(cold);
  });
  it("exposes the cold-start detection constant", () => {
    expect(DETECTION_COLD).toBe(0.6);
  });
});

describe("structural sets are internally consistent", () => {
  it("every NO_BRAINER key is a legal (detector, action) pair", () => {
    for (const key of NO_BRAINER) {
      const [det, act] = key.split(":");
      const actions = (DETECTOR_TO_ACTIONS as Record<string, string[]>)[det];
      expect(actions, `detector ${det} must exist`).toBeTruthy();
      expect(actions).toContain(act);
    }
  });

  it("ships exactly the three baseline autopilot features", () => {
    expect([...NO_BRAINER].sort()).toEqual([
      "campaign_below_breakeven:pause_campaign",
      "negative_unit_economics:pause_campaign",
      "sku_stockout_vs_spend:pause_campaign",
    ]);
  });
  it("every executor kind has a tier", () => {
    for (const k of HAS_EXECUTOR) expect(["reversible","hard_to_reverse","irreversible"]).toContain(actionTier(k));
  });
  it("reversibilityFactor is ordered", () => {
    expect(reversibilityFactor("reversible")).toBeGreaterThan(reversibilityFactor("hard_to_reverse"));
    expect(reversibilityFactor("hard_to_reverse")).toBeGreaterThan(reversibilityFactor("irreversible"));
  });
});
