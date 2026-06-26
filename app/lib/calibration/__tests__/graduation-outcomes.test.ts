import { describe, it, expect } from "vitest";
import { graduationVerdict, MIN_OUTCOMES } from "../graduation";

const base = {
  detectorId: "campaign_below_breakeven",
  actionKind: "reduce_campaign_budget" as const,
  lastConf: 90,
  gradThreshold: 75,
  cleanApprovals: 10,
  consecutiveUndos: 0,
  merchantDisabled: false,
  onProbation: false,
  hasUndoBranch: true,
  netPositiveOutcomes: 5,
  lastOutcomeSign: 1 as -1 | 0 | 1,
};

describe("graduationVerdict outcome gating", () => {
  it("graduates when both bars are met", () => {
    expect(graduationVerdict(base).graduated).toBe(true);
  });

  it("blocks when measured outcomes are below the bar", () => {
    const v = graduationVerdict({ ...base, netPositiveOutcomes: 1 });
    expect(v.graduated).toBe(false);
    expect(v.reason).toMatch(/proven/i);
  });

  it("demotes on a recent measured loss even with enough approvals", () => {
    const v = graduationVerdict({ ...base, lastOutcomeSign: -1 });
    expect(v.graduated).toBe(false);
    expect(v.reason).toMatch(/loss/i);
  });

  it("exempts no-brainers from the outcome BAR but not from loss demotion", () => {
    const nb = {
      ...base,
      detectorId: "campaign_below_breakeven",
      actionKind: "pause_campaign" as const,
      netPositiveOutcomes: 0, // below bar, but no-brainer is exempt
    };
    expect(graduationVerdict(nb).graduated).toBe(true);
    // ...until a measured loss lands:
    expect(graduationVerdict({ ...nb, lastOutcomeSign: -1 }).graduated).toBe(false);
  });

  it("exposes the per-tier outcome minimums", () => {
    expect(MIN_OUTCOMES.reversible).toBe(3);
    expect(MIN_OUTCOMES.hard_to_reverse).toBe(5);
    expect(MIN_OUTCOMES.irreversible).toBe(8);
  });
});
