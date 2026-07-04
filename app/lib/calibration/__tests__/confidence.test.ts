import { describe, it, expect } from "vitest";
import {
  pairPrior, historical, confidence, calibrationPct, smooth, clampToDayAnchor,
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
  it("treats adjust_price as hard_to_reverse (customer-visible but undoable)", () => {
    expect(actionTier("adjust_price")).toBe("hard_to_reverse");
  });
  it("reversibilityFactor is ordered", () => {
    expect(reversibilityFactor("reversible")).toBeGreaterThan(reversibilityFactor("hard_to_reverse"));
    expect(reversibilityFactor("hard_to_reverse")).toBeGreaterThan(reversibilityFactor("irreversible"));
  });
});

describe("detectionFactor (learned detector reliability)", () => {
  // Import here keeps the top-of-file import list untouched for older tests.
  it("returns the cold default when the detector never fired", async () => {
    const { detectionFactor, DETECTION_COLD: COLD } = await import("../confidence");
    expect(detectionFactor(0, 0)).toBe(COLD);
  });
  it("is capped at the cold value until 10 alerts have fired", async () => {
    const { detectionFactor, DETECTION_COLD: COLD } = await import("../confidence");
    // Laplace (5-0+1)/(5+2) = 0.857 but n<10 -> capped at 0.6
    expect(detectionFactor(5, 0)).toBe(COLD);
    // heavy challenges below the sample floor still drop it below the cap
    expect(detectionFactor(5, 5)).toBeLessThan(COLD);
  });
  it("rises above the cold cap once 10+ alerts fired with few challenges", async () => {
    const { detectionFactor } = await import("../confidence");
    // (10 - 0 + 10*0.6) / (10 + 10) = 0.8 — the cold-centered prior damps the climb
    expect(detectionFactor(10, 0)).toBeCloseTo(0.8, 3);
    expect(detectionFactor(100, 0)).toBeGreaterThan(0.95);
  });
  it("falls toward the floor when the merchant challenges most detections", async () => {
    const { detectionFactor, DETECTION_FLOOR } = await import("../confidence");
    // Symmetric damping: pessimistic small samples are blended too, not trusted raw
    expect(detectionFactor(20, 18)).toBeCloseTo((2 + 6) / 30, 3);
    expect(detectionFactor(20, 20)).toBe(DETECTION_FLOOR);
    expect(detectionFactor(200, 200)).toBe(DETECTION_FLOOR);
  });
  it("one challenge on a tiny sample is damped, not trusted raw", async () => {
    const { detectionFactor } = await import("../confidence");
    // (1 - 1 + 6) / (1 + 10) = 0.545 — vs 0.33 under an undamped Laplace mean
    expect(detectionFactor(1, 1)).toBeCloseTo(6 / 11, 3);
  });
  it("clamps challenged to fired and never exceeds 1", async () => {
    const { detectionFactor } = await import("../confidence");
    expect(detectionFactor(10, 999)).toBeGreaterThanOrEqual(0.2);
    expect(detectionFactor(10_000, 0)).toBeLessThanOrEqual(1);
  });
});

describe("ratchetedReversibility (earned reversibility, spec section 3)", () => {
  it("starts at the tier base with no streak", async () => {
    const { ratchetedReversibility } = await import("../confidence");
    expect(ratchetedReversibility("reversible", 0)).toBe(1.0);
    expect(ratchetedReversibility("hard_to_reverse", 0)).toBe(0.5);
    expect(ratchetedReversibility("irreversible", 0)).toBe(0.2);
  });
  it("earns +0.10 per 10 consecutive clean approvals", async () => {
    const { ratchetedReversibility } = await import("../confidence");
    expect(ratchetedReversibility("irreversible", 9)).toBe(0.2);
    expect(ratchetedReversibility("irreversible", 10)).toBeCloseTo(0.3, 6);
    expect(ratchetedReversibility("irreversible", 25)).toBeCloseTo(0.4, 6);
    expect(ratchetedReversibility("hard_to_reverse", 30)).toBeCloseTo(0.8, 6);
  });
  it("caps at 1.0 so even an irreversible pair can be fully earned up", async () => {
    const { ratchetedReversibility } = await import("../confidence");
    expect(ratchetedReversibility("irreversible", 80)).toBe(1.0);
    expect(ratchetedReversibility("irreversible", 800)).toBe(1.0);
  });
});

describe("pairConfidence — learned factors (opts)", () => {
  it("a better learned detection factor raises confidence above the cold default", () => {
    const cold = pairConfidence("campaign_below_breakeven", "pause_campaign", { alpha: 5, beta: 0 }, null);
    const learned = pairConfidence("campaign_below_breakeven", "pause_campaign", { alpha: 5, beta: 0 }, null, { detection: 0.95 });
    expect(learned).toBeGreaterThan(cold);
  });
  it("the clean-approval streak raises a risky pair via the ratchet", () => {
    const base = pairConfidence("reorder_timing", "create_po_draft", { alpha: 10, beta: 0 }, null);
    const earned = pairConfidence("reorder_timing", "create_po_draft", { alpha: 10, beta: 0 }, null, { consecutiveCleanApprovals: 20 });
    expect(earned).toBeGreaterThan(base);
  });
  it("omitted/invalid opts reproduce the exact previous behavior", () => {
    const a = pairConfidence("campaign_below_breakeven", "pause_campaign", { alpha: 2, beta: 1 }, null);
    const b = pairConfidence("campaign_below_breakeven", "pause_campaign", { alpha: 2, beta: 1 }, null, {});
    const c = pairConfidence("campaign_below_breakeven", "pause_campaign", { alpha: 2, beta: 1 }, null, { detection: Number.NaN, consecutiveCleanApprovals: Number.NaN });
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
  it("exclude_geo and push_creative_draft have executors now — no longer vetoed to 0", () => {
    expect(HAS_EXECUTOR.has("exclude_geo")).toBe(true);
    expect(HAS_EXECUTOR.has("push_creative_draft")).toBe(true);
    expect(pairConfidence("regional_shortage_risk", "exclude_geo", { alpha: 0, beta: 0 }, null)).toBeGreaterThan(0);
  });
});

describe("clampToDayAnchor (I6 hourly-cadence day bound)", () => {
  it("is a no-op with a null anchor (first-ever recompute)", () => {
    expect(clampToDayAnchor(83, null)).toBe(83);
  });
  it("clamps upward drift to anchor + 5", () => {
    expect(clampToDayAnchor(40, 30)).toBe(35);
  });
  it("clamps downward drift to anchor - 5", () => {
    expect(clampToDayAnchor(10, 30)).toBe(25);
  });
  it("passes through values inside the day window", () => {
    expect(clampToDayAnchor(33, 30)).toBe(33);
    expect(clampToDayAnchor(27, 30)).toBe(27);
  });
  it("never clamps outside [0, 100]", () => {
    expect(clampToDayAnchor(0, 2)).toBe(0);
    expect(clampToDayAnchor(100, 98)).toBe(100);
  });
  it("bounds a full day of hourly ±5 smooth() steps to ±5 total", () => {
    // Simulate 24 hourly recomputes all pulling hard toward raw=100 from 20.
    const anchor = 20;
    let display = 20;
    for (let h = 0; h < 24; h++) {
      display = clampToDayAnchor(smooth(100, display), anchor, display);
    }
    expect(display).toBe(25); // anchor + 5, not 20 + 24*5
  });
  it("never reverts or inverts a merchant nudge that stepped outside the band", () => {
    // Anchor 50 (band [45,55]); a forceVisibleStep nudge wrote 56. A passive
    // hourly run pulling toward raw=90 must hold at 56 (band expands to
    // include prev), never fall back to 55.
    expect(clampToDayAnchor(smooth(90, 56), 50, 56)).toBe(56);
    // And a second merchant approve from 56 must not move DOWN either.
    expect(clampToDayAnchor(smooth(90, 56), 50, 56)).toBeGreaterThanOrEqual(56);
  });
});
