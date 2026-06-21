import { describe, it, expect } from "vitest";
import { graduationVerdict, GRADUATABLE_V1, MIN_APPROVALS } from "../graduation";

/** A fully-qualifying reversible pair (all gates pass). */
const PASSING: Parameters<typeof graduationVerdict>[0] = {
  actionKind: "pause_campaign",
  lastConf: 80,
  gradThreshold: 75,
  cleanApprovals: 3,
  consecutiveUndos: 0,
  merchantDisabled: false,
  onProbation: false,
  hasUndoBranch: true,
};

describe("graduationVerdict — passing case", () => {
  it("graduates a fully-qualifying reversible pair", () => {
    const v = graduationVerdict(PASSING);
    expect(v.graduated).toBe(true);
    expect(v.reason).toBe("all gates passed");
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
