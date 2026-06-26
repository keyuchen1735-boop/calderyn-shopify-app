/**
 * Task 8 invariant tests (I8 + opt-in default + reallocate tripwire).
 *
 * Covers:
 *  1. Queue no-brainer mute-resistance: a muted NO_BRAINER pair stays in the
 *     queue as always_ask=true; a muted normal pair is excluded.
 *  2. Confidence floor: a NO_BRAINER pair with extreme reject-spam still has
 *     conf >= NO_BRAINER_CONF_FLOOR; a normal pair (no-executor → conf 0)
 *     has no such floor applied.
 *  3. Opt-in default: a fresh shop (no graduated pairs) executes nothing
 *     autonomously — asserted via graduationVerdict for all fresh inputs.
 *  4. GRADUATABLE set membership: 7 kinds as of Phase 2.
 */

import { describe, it, expect } from "vitest";
import { buildActionQueue } from "../queue.server";
import {
  pairConfidence,
  NO_BRAINER,
  NO_BRAINER_CONF_FLOOR,
} from "../confidence";
import { graduationVerdict, GRADUATABLE } from "../graduation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Alert shape that satisfies the queue builder. */
const makeAlert = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  detector_id: "campaign_below_breakeven",
  severity: "high",
  status: "open",
  dollar_impact: 10000,
  claude_rank: 1,
  created_at: "2026-06-21T00:00:00Z",
  title: "Campaign losing money",
  narrative: "ROAS 0.7",
  campaign: "Camp A",
  campaign_id: "c1",
  campaign_external_id: null,
  sku: null,
  evidence: { campaign_id: "c1" },
  ...over,
});

// campaign_below_breakeven:pause_campaign is a confirmed NO_BRAINER pair
// (hasCampaign=true → recommendedAction returns "pause_campaign").
const NB_DETECTOR = "campaign_below_breakeven";
const NB_ACTION = "pause_campaign";
const NB_PAIR = `${NB_DETECTOR}:${NB_ACTION}`;

// A normal (non-no-brainer) pair: reorder_timing:create_po_draft.
// This pair is NOT in NO_BRAINER and has an executor (no guardrail veto).
// recommendedAction("reorder_timing", { hasCampaign: false }) → "create_po_draft".
const NORMAL_DETECTOR = "reorder_timing";
const NORMAL_ACTION = "create_po_draft";
const NORMAL_PAIR = `${NORMAL_DETECTOR}:${NORMAL_ACTION}`;

// ---------------------------------------------------------------------------
// 1. Queue: no-brainer mute-resistance (I8)
// ---------------------------------------------------------------------------

describe("Queue — no-brainer mute-resistance (I8)", () => {
  it("confirms the test pair is in NO_BRAINER", () => {
    expect(NO_BRAINER.has(NB_PAIR)).toBe(true);
  });

  it("confirms the normal test pair is NOT in NO_BRAINER", () => {
    expect(NO_BRAINER.has(NORMAL_PAIR)).toBe(false);
  });

  it("a muted NO_BRAINER pair still appears in the queue with always_ask=true", () => {
    const muted = new Set([NB_PAIR]);
    const q = buildActionQueue(
      [makeAlert()] as never,
      new Map(),
      new Set(),
      muted,
    );
    expect(q).toHaveLength(1);
    expect(q[0].alertId).toBe("a1");
    expect(q[0].always_ask).toBe(true);
  });

  it("a muted normal pair is excluded from the queue entirely", () => {
    // reorder_timing:create_po_draft — not a no-brainer, muting removes it.
    const normalAlert = makeAlert({
      id: "a2",
      detector_id: NORMAL_DETECTOR,
      campaign_id: null,
      evidence: {},
    });
    const muted = new Set([NORMAL_PAIR]);
    const q = buildActionQueue(
      [normalAlert] as never,
      new Map(),
      new Set(),
      muted,
    );
    expect(q).toHaveLength(0);
  });

  it("an un-muted NO_BRAINER pair appears without the always_ask flag", () => {
    const q = buildActionQueue(
      [makeAlert()] as never,
      new Map(),
      new Set(),
      new Set(), // no mutes
    );
    expect(q).toHaveLength(1);
    expect(q[0].always_ask).toBeUndefined();
  });

  it("muting a NO_BRAINER does NOT remove it (unlike a normal pair)", () => {
    // NO_BRAINER alert: campaign_below_breakeven with campaign_id (hasCampaign=true).
    // Normal alert: reorder_timing without campaign (hasCampaign=false).
    // Mute both pairs — only the NO_BRAINER survives (as always_ask).
    const normalAlert = makeAlert({
      id: "a2",
      detector_id: NORMAL_DETECTOR,
      campaign_id: null,
      evidence: {},
    });
    const muted = new Set([NB_PAIR, NORMAL_PAIR]);
    const q = buildActionQueue(
      [makeAlert(), normalAlert] as never,
      new Map(),
      new Set(),
      muted,
    );
    // Only the NO_BRAINER survives (as always_ask)
    expect(q).toHaveLength(1);
    expect(q[0].alertId).toBe("a1");
    expect(q[0].always_ask).toBe(true);
  });

  it("a muted NO_BRAINER that is also graduated is still excluded (I5 takes priority)", () => {
    // Graduated = autopilot handles it; must not appear in the queue regardless
    // of no-brainer status (I5 no-double-actor rule).
    const muted = new Set([NB_PAIR]);
    const graduated = new Set([NB_PAIR]);
    const q = buildActionQueue(
      [makeAlert()] as never,
      new Map(),
      new Set(),
      muted,
      graduated,
    );
    expect(q).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Confidence floor for NO_BRAINER pairs (I8)
// ---------------------------------------------------------------------------

describe("Confidence floor — no-brainer pairs (I8)", () => {
  it("NO_BRAINER_CONF_FLOOR is a positive integer <= 50", () => {
    expect(typeof NO_BRAINER_CONF_FLOOR).toBe("number");
    expect(Number.isInteger(NO_BRAINER_CONF_FLOOR)).toBe(true);
    expect(NO_BRAINER_CONF_FLOOR).toBeGreaterThan(0);
    expect(NO_BRAINER_CONF_FLOOR).toBeLessThanOrEqual(50);
  });

  it("a NO_BRAINER pair with heavy reject-spam still has conf >= floor", () => {
    // Simulate extreme reject-spam: 1000 beta (rejects), 0 alpha (approvals).
    const spammedConf = pairConfidence(NB_DETECTOR, NB_ACTION, { alpha: 0, beta: 1000 }, null);
    expect(spammedConf).toBeGreaterThanOrEqual(NO_BRAINER_CONF_FLOOR);
  });

  it("cold-start NO_BRAINER conf is already above the floor (floor does not interfere)", () => {
    const coldConf = pairConfidence(NB_DETECTOR, NB_ACTION, { alpha: 0, beta: 0 }, null);
    // Cold-start is ~74 (the canonical no-brainer value); well above the floor.
    expect(coldConf).toBeGreaterThan(NO_BRAINER_CONF_FLOOR);
  });

  it("a normal pair with no executor reaches conf=0 and the floor is NOT applied", () => {
    // snooze_alert has guardrailVeto=0 → confidence() returns 0 unconditionally.
    // The floor must NOT apply here (snooze_alert is not in NO_BRAINER).
    const noExecConf = pairConfidence(
      "campaign_below_breakeven",
      "snooze_alert",
      { alpha: 0, beta: 0 },
      null,
    );
    expect(noExecConf).toBe(0);
    expect(noExecConf).toBeLessThan(NO_BRAINER_CONF_FLOOR);
  });

  it("the baseline canary: cold-start sku_stockout_vs_spend:pause_campaign is ~74", () => {
    // This is the canonical no-brainer cold-start value from the confidence test.
    // The floor (20) must not change this (74 > 20 — no clamping occurs).
    const conf = pairConfidence("sku_stockout_vs_spend", "pause_campaign", { alpha: 0, beta: 0 }, null);
    expect(conf).toBe(74);
  });

  it("floor is not applied to campaign_below_breakeven:snooze_alert (no executor)", () => {
    // This verifies the floor is strictly NO_BRAINER-pair-gated:
    // campaign_below_breakeven + snooze_alert is NOT a NO_BRAINER pair.
    // Its conf must be 0 (guardrail veto) even though the detector is the same
    // as our NO_BRAINER test pair.
    const conf = pairConfidence("campaign_below_breakeven", "snooze_alert", { alpha: 100, beta: 0 }, null);
    expect(conf).toBe(0);
    expect(conf).toBeLessThan(NO_BRAINER_CONF_FLOOR);
  });
});

// ---------------------------------------------------------------------------
// 3. Opt-in default invariant
// ---------------------------------------------------------------------------

describe("Default autonomy invariant — only shipped no-brainers start unlocked", () => {
  /**
   * Ordinary pairs still need evidence at cold start. The three explicit
   * no-brainer detector/action pairs are tested separately as unlocked defaults.
   * The shop-level Autopilot setting remains the outer execution switch.
   */

  const FRESH_INPUT = {
    detectorId: "regional_spend_starved_stock",
    lastConf: 74,          // highest cold-start conf (no-brainer level)
    gradThreshold: 75,     // typical graduation threshold
    cleanApprovals: 0,     // fresh shop: zero approvals
    consecutiveUndos: 0,
    merchantDisabled: false,
    onProbation: false,
    hasUndoBranch: true,
    netPositiveOutcomes: 0,
    lastOutcomeSign: 0 as -1 | 0 | 1,
  };

  it("a normal pause pair does NOT graduate for a fresh shop", () => {
    const v = graduationVerdict({ ...FRESH_INPUT, actionKind: "pause_campaign" });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("needs more approvals");
  });

  it("reduce_campaign_budget does NOT graduate for a fresh shop (zero approvals)", () => {
    const v = graduationVerdict({ ...FRESH_INPUT, actionKind: "reduce_campaign_budget" });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("needs more approvals");
  });

  it("no non-no-brainer kind in GRADUATABLE graduates with zero approvals", () => {
    for (const kind of GRADUATABLE) {
      const v = graduationVerdict({ ...FRESH_INPUT, actionKind: kind });
      expect(v.graduated).toBe(false);
    }
  });

  it("even with high conf, a fresh shop still cannot graduate (approval gate is independent)", () => {
    // conf=100, but 0 approvals → still blocked
    const v = graduationVerdict({
      ...FRESH_INPUT,
      lastConf: 100,
      gradThreshold: 75,
      cleanApprovals: 0,
      actionKind: "pause_campaign",
    });
    expect(v.graduated).toBe(false);
    expect(v.reason).toBe("needs more approvals");
  });

  it("the shop-level autopilot switch remains the outer opt-in gate", () => {
    // Two-layer wall:
    //  (a) autopilot_enabled=false → runAutopilotForShop returns {skipped:true} immediately.
    //  (b) Zero approved pairs → no pair graduates → isGraduated=false for all candidates.
    // We assert (b) here: EVERY kind in GRADUATABLE fails graduation with 0 approvals.
    // Combined with (a), this is the complete opt-in guarantee.
    expect(GRADUATABLE.size).toBeGreaterThan(0); // invariant: the graduatable set is non-empty
    for (const kind of GRADUATABLE) {
      const v = graduationVerdict({ ...FRESH_INPUT, cleanApprovals: 0, actionKind: kind });
      expect(v.graduated).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. GRADUATABLE set membership (Phase 2: 7 kinds)
// ---------------------------------------------------------------------------

describe("GRADUATABLE set — Phase 2 membership", () => {
  it("contains all seven approved kinds", () => {
    expect(GRADUATABLE.has("pause_campaign")).toBe(true);
    expect(GRADUATABLE.has("reduce_campaign_budget")).toBe(true);
    expect(GRADUATABLE.has("discontinue_sku")).toBe(true);
    expect(GRADUATABLE.has("resume_campaign")).toBe(true);
    expect(GRADUATABLE.has("reallocate_budget")).toBe(true);
    expect(GRADUATABLE.has("reallocate_inventory")).toBe(true);
    expect(GRADUATABLE.has("adjust_price")).toBe(true);
    expect(GRADUATABLE.size).toBe(7);
  });

  it("does NOT contain increase_campaign_budget or reallocate_spend_sku", () => {
    expect(GRADUATABLE.has("increase_campaign_budget")).toBe(false);
    expect(GRADUATABLE.has("reallocate_spend_sku")).toBe(false);
  });
});
