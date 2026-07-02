import { describe, it, expect } from "vitest";
import { graduationVerdict, GRADUATABLE, MIN_APPROVALS } from "../graduation";

/** A fully-qualifying reversible pair (all gates pass). */
const PASSING: Parameters<typeof graduationVerdict>[0] = {
  detectorId: "regional_spend_starved_stock",
  actionKind: "pause_campaign",
  lastConf: 80,
  gradThreshold: 75,
  cleanApprovals: 3,
  consecutiveUndos: 0,
  merchantDisabled: false,
  onProbation: false,
  hasUndoBranch: true,
  netPositiveOutcomes: 3,
  lastOutcomeSign: 0,
};

describe("graduationVerdict — passing case", () => {
  it("graduates a fully-qualifying reversible pair", () => {
    const v = graduationVerdict(PASSING);
    expect(v.graduated).toBe(true);
    expect(v.reason).toBe("all gates passed");
  });
});

describe("graduationVerdict — shipped no-brainers", () => {
  it.each([
    ["sku_stockout_vs_spend", "pause_campaign"],
    ["campaign_below_breakeven", "pause_campaign"],
    ["negative_unit_economics", "pause_campaign"],
  ] as const)("%s:%s is auto-unlocked without approval history", (detectorId, actionKind) => {
    const v = graduationVerdict({
      ...PASSING,
      detectorId,
      actionKind,
      lastConf: 74,
      cleanApprovals: 0,
    });
    expect(v.graduated).toBe(true);
    expect(v.reason).toBe("shipped no-brainer");
  });

  it("still respects the merchant off switch", () => {
    const v = graduationVerdict({
      ...PASSING,
      detectorId: "campaign_below_breakeven",
      cleanApprovals: 0,
      lastConf: 74,
      merchantDisabled: true,
    });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("merchant disabled");
  });
});

describe("graduationVerdict — gate failures (each condition in isolation)", () => {
  it('non-graduatable kind (increase_campaign_budget) → "kind not graduatable"', () => {
    const v = graduationVerdict({ ...PASSING, actionKind: "increase_campaign_budget" });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("kind not graduatable");
  });

  it('hasUndoBranch=false → "no undo branch"', () => {
    const v = graduationVerdict({ ...PASSING, hasUndoBranch: false });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("no undo branch");
  });

  it('merchantDisabled=true → "merchant disabled"', () => {
    const v = graduationVerdict({ ...PASSING, merchantDisabled: true });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("merchant disabled");
  });

  it('onProbation=true → "on probation"', () => {
    const v = graduationVerdict({ ...PASSING, onProbation: true });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("on probation");
  });

  it('consecutiveUndos=1 → "recent undo"', () => {
    const v = graduationVerdict({ ...PASSING, consecutiveUndos: 1 });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("recent undo");
  });

  it('cleanApprovals=2 (below MIN_APPROVALS.reversible=3) → "needs more approvals"', () => {
    const v = graduationVerdict({ ...PASSING, cleanApprovals: 2 });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("needs more approvals");
  });

  it('lastConf=74 with gradThreshold=75 → "below confidence bar"', () => {
    const v = graduationVerdict({ ...PASSING, lastConf: 74, gradThreshold: 75 });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("below confidence bar");
  });
});

describe("graduationVerdict — kinds that must never graduate", () => {
  it("increase_campaign_budget never graduates even with perfect stats", () => {
    const v = graduationVerdict({ ...PASSING, actionKind: "increase_campaign_budget" });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("kind not graduatable");
  });
});

describe("GRADUATABLE set contents", () => {
  it("contains the original three kinds", () => {
    expect(GRADUATABLE.has("pause_campaign")).toBe(true);
    expect(GRADUATABLE.has("reduce_campaign_budget")).toBe(true);
    expect(GRADUATABLE.has("discontinue_sku")).toBe(true);
  });

  it("contains the four new Phase 2 kinds", () => {
    expect(GRADUATABLE.has("resume_campaign")).toBe(true);
    expect(GRADUATABLE.has("reallocate_budget")).toBe(true);
    expect(GRADUATABLE.has("reallocate_inventory")).toBe(true);
    expect(GRADUATABLE.has("adjust_price")).toBe(true);
  });

  it("does NOT contain increase_campaign_budget", () => {
    expect(GRADUATABLE.has("increase_campaign_budget")).toBe(false);
  });
});

describe("MIN_APPROVALS constants", () => {
  it("reversible=3, hard_to_reverse=10, irreversible=25", () => {
    expect(MIN_APPROVALS.reversible).toBe(3);
    expect(MIN_APPROVALS.hard_to_reverse).toBe(10);
    expect(MIN_APPROVALS.irreversible).toBe(25);
  });
});

describe("graduationVerdict — reduce_campaign_budget also graduates", () => {
  it("graduates reduce_campaign_budget with all gates passing", () => {
    const v = graduationVerdict({ ...PASSING, actionKind: "reduce_campaign_budget" });
    expect(v.graduated).toBe(true);
    expect(v.reason).toBe("all gates passed");
  });
});

describe("graduationVerdict — boundary conditions", () => {
  it("exactly MIN_APPROVALS.reversible (3) approvals passes the gate", () => {
    const v = graduationVerdict({ ...PASSING, cleanApprovals: 3 });
    expect(v.graduated).toBe(true);
  });

  it("lastConf exactly equal to gradThreshold passes the gate", () => {
    const v = graduationVerdict({ ...PASSING, lastConf: 75, gradThreshold: 75 });
    expect(v.graduated).toBe(true);
  });
});

describe("graduationVerdict — discontinue_sku (hard_to_reverse: 10-approval floor)", () => {
  // discontinue_sku is graduatable (it has a working undo branch) but is more
  // consequential than a campaign tweak, so it sits in the hard_to_reverse tier
  // and the gate demands MIN_APPROVALS.hard_to_reverse (10), not the reversible 3.
  const DISCONTINUE: Parameters<typeof graduationVerdict>[0] = {
    ...PASSING,
    actionKind: "discontinue_sku",
    cleanApprovals: 10,
    netPositiveOutcomes: 5,
    // hard_to_reverse pairs must clear the TIER floor (88, spec §3): the stored
    // 75 threshold is floored up by effectiveGraduationThreshold.
    lastConf: 90,
  };

  it("is in the graduatable set", () => {
    expect(GRADUATABLE.has("discontinue_sku")).toBe(true);
  });

  it("graduates with 10 clean approvals + all other gates passing", () => {
    const v = graduationVerdict(DISCONTINUE);
    expect(v.graduated).toBe(true);
    expect(v.reason).toBe("all gates passed");
  });

  it("the gate is tier-aware: 9 approvals fails, 10 passes (hard_to_reverse floor)", () => {
    expect(graduationVerdict({ ...DISCONTINUE, cleanApprovals: 9 }).graduated).toBe(false);
    expect(graduationVerdict({ ...DISCONTINUE, cleanApprovals: 9 }).reason).toBe(
      "needs more approvals",
    );
    expect(graduationVerdict({ ...DISCONTINUE, cleanApprovals: 10 }).graduated).toBe(true);
  });

  it("does NOT graduate at the reversible floor (3) — a campaign pair would", () => {
    // Same 3 approvals: a reversible pause graduates, but a hard_to_reverse
    // discontinue does not — proving the floor follows the action's tier.
    expect(graduationVerdict({ ...PASSING, cleanApprovals: 3 }).graduated).toBe(true);
    expect(graduationVerdict({ ...DISCONTINUE, cleanApprovals: 3 }).graduated).toBe(false);
  });

  it("still requires a working undo branch", () => {
    const v = graduationVerdict({ ...DISCONTINUE, hasUndoBranch: false });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("no undo branch");
  });
});

describe("effectiveGraduationThreshold — tier floors (spec section 3: 75/88/95)", () => {
  it("floors each tier regardless of the stored default", async () => {
    const { effectiveGraduationThreshold } = await import("../graduation");
    expect(effectiveGraduationThreshold("pause_campaign", 75)).toBe(75);
    expect(effectiveGraduationThreshold("discontinue_sku", 75)).toBe(88);
    expect(effectiveGraduationThreshold("reallocate_inventory", 75)).toBe(95);
  });
  it("respects a reject-raised stored threshold above the floor, capped at 99", async () => {
    const { effectiveGraduationThreshold } = await import("../graduation");
    expect(effectiveGraduationThreshold("pause_campaign", 85)).toBe(85);
    expect(effectiveGraduationThreshold("discontinue_sku", 93)).toBe(93);
    expect(effectiveGraduationThreshold("reallocate_inventory", 120)).toBe(99);
  });
  it("treats a missing/zero stored threshold as the tier floor", async () => {
    const { effectiveGraduationThreshold } = await import("../graduation");
    expect(effectiveGraduationThreshold("pause_campaign", 0)).toBe(75);
    expect(effectiveGraduationThreshold("reallocate_inventory", Number.NaN)).toBe(95);
  });
});

describe("graduationVerdict — no-brainer demote-to-ask (I8)", () => {
  const NB: Parameters<typeof graduationVerdict>[0] = {
    ...PASSING,
    detectorId: "campaign_below_breakeven",
    actionKind: "pause_campaign",
    // A cold no-brainer ships with zero synthetic approvals/outcomes — the
    // short-circuit exempts it from those bars, NOT from the conf bar below.
    cleanApprovals: 0,
    netPositiveOutcomes: 0,
  };

  it("stays unlocked at cold-start confidence (~74)", () => {
    const v = graduationVerdict({ ...NB, lastConf: 74 });
    expect(v.graduated).toBe(true);
    expect(v.reason).toBe("shipped no-brainer");
  });

  it("demotes to always-ask once rejects push confidence below the no-brainer bar", () => {
    const v = graduationVerdict({ ...NB, lastConf: 69 });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("below confidence bar");
  });

  it("re-unlocks when approvals earn confidence back", () => {
    expect(graduationVerdict({ ...NB, lastConf: 70 }).graduated).toBe(true);
    expect(graduationVerdict({ ...NB, lastConf: 90 }).graduated).toBe(true);
  });

  it("mute/probation/undo/measured-loss still demote a no-brainer regardless of confidence", () => {
    expect(graduationVerdict({ ...NB, lastConf: 90, merchantDisabled: true }).graduated).toBe(false);
    expect(graduationVerdict({ ...NB, lastConf: 90, onProbation: true }).graduated).toBe(false);
    expect(graduationVerdict({ ...NB, lastConf: 90, consecutiveUndos: 1 }).graduated).toBe(false);
    expect(graduationVerdict({ ...NB, lastConf: 90, lastOutcomeSign: -1 }).graduated).toBe(false);
  });
});
