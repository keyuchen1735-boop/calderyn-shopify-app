import { describe, it, expect } from "vitest";
import { confFromEv, trustDelta, ZERO_APPROVE_RECEIPT } from "../delta";
import { pairConfidence } from "../confidence";

// These tests pin the pure before/after delta math used by recordApproval /
// recordRejection. They use the SAME peerP50=null path the synchronous
// approve/reject code uses (skipPeerPrior), so the numbers here are exactly what
// the server will compute from a known alpha/beta pair.

describe("confFromEv", () => {
  it("matches pairConfidence with peerP50=null for a known pair", () => {
    const ev = { alpha: 3, beta: 1 };
    expect(confFromEv("campaign_below_breakeven", "pause_campaign", ev)).toBe(
      pairConfidence("campaign_below_breakeven", "pause_campaign", ev, null),
    );
  });

  it("treats a missing/cold pair as alpha=0, beta=0 (still a valid number)", () => {
    const c = confFromEv("campaign_below_breakeven", "pause_campaign", { alpha: 0, beta: 0 });
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(100);
  });
});

describe("trustDelta (approve raises, reject lowers)", () => {
  const PAIR = { detectorId: "campaign_below_breakeven", actionKind: "pause_campaign" as const };

  it("returns a non-negative delta when alpha increases (approval)", () => {
    const before = { alpha: 0, beta: 0 };
    const after = { alpha: 1, beta: 0 }; // one clean approval bumps alpha
    const d = trustDelta(PAIR.detectorId, PAIR.actionKind, before, after);
    expect(d.before).toBe(confFromEv(PAIR.detectorId, PAIR.actionKind, before));
    expect(d.after).toBe(confFromEv(PAIR.detectorId, PAIR.actionKind, after));
    expect(d.delta).toBe(Math.round(d.after - d.before));
    expect(d.delta).toBeGreaterThanOrEqual(0);
  });

  it("returns a non-positive delta when beta increases (rejection)", () => {
    const before = { alpha: 2, beta: 0 };
    const after = { alpha: 2, beta: 1 }; // a reject bumps beta, lowering conf
    const d = trustDelta(PAIR.detectorId, PAIR.actionKind, before, after);
    expect(d.delta).toBeLessThanOrEqual(0);
    expect(d.delta).toBe(Math.round(d.after - d.before));
  });

  it("delta is the rounded difference of the two confidences (integer)", () => {
    const before = { alpha: 5, beta: 2 };
    const after = { alpha: 6, beta: 2 };
    const d = trustDelta(PAIR.detectorId, PAIR.actionKind, before, after);
    expect(Number.isInteger(d.delta)).toBe(true);
  });
});

describe("ZERO_APPROVE_RECEIPT", () => {
  it("is all zeros / false (the fail-safe default)", () => {
    expect(ZERO_APPROVE_RECEIPT).toEqual({
      delta: 0,
      before: 0,
      after: 0,
      cleanApprovals: 0,
      graduatable: false,
      graduationThreshold: 0,
      justGraduated: false,
    });
  });
});
