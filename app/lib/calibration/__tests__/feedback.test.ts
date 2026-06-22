import { describe, it, expect } from "vitest";
import { rejectEffect, reflection, approveReflection } from "../feedback";

describe("rejectEffect", () => {
  it("too_aggressive: beta 0.5, grad +5, dollar cap, no mute", () => {
    expect(rejectEffect("too_aggressive")).toEqual({ betaDelta: 0.5, gradDelta: 5, mute: false, ruleKind: "pair_dollar_cap" });
  });
  it("i_handle_this: NO beta change, mutes, muted_pair rule", () => {
    expect(rejectEffect("i_handle_this")).toEqual({ betaDelta: 0, gradDelta: 0, mute: true, ruleKind: "muted_pair" });
  });
  it("not_enough_data: beta 1, grad +2, probation rule", () => {
    expect(rejectEffect("not_enough_data")).toEqual({ betaDelta: 1, gradDelta: 2, mute: false, ruleKind: "pair_probation_until" });
  });
  it("wrong_timing: beta 0.5, no rule this slice", () => {
    expect(rejectEffect("wrong_timing")).toEqual({ betaDelta: 0.5, gradDelta: 0, mute: false, ruleKind: null });
  });
  it("other: beta 1, no rule", () => {
    expect(rejectEffect("other")).toEqual({ betaDelta: 1, gradDelta: 0, mute: false, ruleKind: null });
  });
});

describe("reflection", () => {
  it("renders plain language per reason with the pair labels and no em dash", () => {
    const r = reflection("i_handle_this", "sku_stockout_vs_spend", "pause_campaign");
    expect(r.length).toBeGreaterThan(0);
    expect(r).not.toContain("—"); // em dash
    expect(r).not.toContain("–"); // en dash
    expect(r.toLowerCase()).toContain("leave");
  });
  it("too_aggressive contains 'gentler'", () => {
    const r = reflection("too_aggressive", "campaign_below_breakeven", "pause_campaign");
    expect(r).not.toContain("—");
    expect(r).not.toContain("–");
    expect(r.toLowerCase()).toContain("gentler");
  });
  it("wrong_timing contains 'timing'", () => {
    const r = reflection("wrong_timing", "sku_stockout_vs_spend", "reduce_campaign_budget");
    expect(r).not.toContain("—");
    expect(r).not.toContain("–");
    expect(r.toLowerCase()).toContain("timing");
  });
  it("not_enough_data contains 'proof'", () => {
    const r = reflection("not_enough_data", "margin_erosion", "pause_campaign");
    expect(r).not.toContain("—");
    expect(r).not.toContain("–");
    expect(r.toLowerCase()).toContain("proof");
  });
  it("other contains 'reason'", () => {
    const r = reflection("other", "reorder_timing", "create_po_draft");
    expect(r).not.toContain("—");
    expect(r).not.toContain("–");
    expect(r.toLowerCase()).toContain("reason");
  });
});

describe("approveReflection", () => {
  it("is non-empty, first-person, and references the action verb for a known pair", () => {
    const r = approveReflection("campaign_below_breakeven", "pause_campaign");
    expect(r.length).toBeGreaterThan(0);
    // First-person agent voice.
    expect(r.toLowerCase()).toMatch(/\bi'?ll\b|\bi\b/);
    // Mentions what it will now handle (pause).
    expect(r.toLowerCase()).toContain("paus");
  });

  it("contains no em dash or en dash", () => {
    for (const action of ["pause_campaign", "reduce_campaign_budget"] as const) {
      const r = approveReflection("campaign_below_breakeven", action);
      expect(r).not.toContain("—");
      expect(r).not.toContain("–");
    }
  });

  it("is non-empty for every detector/action pairing it is given", () => {
    const r = approveReflection("sku_stockout_vs_spend", "reduce_campaign_budget");
    expect(typeof r).toBe("string");
    expect(r.trim().length).toBeGreaterThan(0);
    // Plain language: no raw snake_case identifiers leak through.
    expect(r).not.toContain("reduce_campaign_budget");
    expect(r).not.toContain("sku_stockout_vs_spend");
  });

  it("falls back gracefully for an unknown detector id (still non-empty, no crash)", () => {
    const r = approveReflection("totally_unknown_detector", "pause_campaign");
    expect(r.trim().length).toBeGreaterThan(0);
    expect(r).not.toContain("—");
  });
});
