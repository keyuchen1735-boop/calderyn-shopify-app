import { describe, it, expect } from "vitest";
import { graduationVerdict, GRADUATABLE_V1, MIN_APPROVALS } from "../graduation";

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
  it('non-v1 kind (increase_campaign_budget) → "kind not graduatable in v1"', () => {
    const v = graduationVerdict({ ...PASSING, actionKind: "increase_campaign_budget" });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("kind not graduatable in v1");
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
    expect(v.reason).toBe("kind not graduatable in v1");
  });

  it("reallocate_inventory never graduates even with perfect stats", () => {
    const v = graduationVerdict({ ...PASSING, actionKind: "reallocate_inventory" });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("kind not graduatable in v1");
  });
});

describe("GRADUATABLE_V1 set contents", () => {
  it("contains pause_campaign and reduce_campaign_budget", () => {
    expect(GRADUATABLE_V1.has("pause_campaign")).toBe(true);
    expect(GRADUATABLE_V1.has("reduce_campaign_budget")).toBe(true);
  });

  it("does NOT contain increase_campaign_budget or reallocate_inventory", () => {
    expect(GRADUATABLE_V1.has("increase_campaign_budget")).toBe(false);
    expect(GRADUATABLE_V1.has("reallocate_inventory")).toBe(false);
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
  };

  it("is in the graduatable set", () => {
    expect(GRADUATABLE_V1.has("discontinue_sku")).toBe(true);
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
