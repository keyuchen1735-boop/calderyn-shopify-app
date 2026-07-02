// Pure graduation-verdict logic for Calderyn Calibration (Slice 5, Task 1).
// No I/O — imports only types. The 7 gates from spec I3/I7 + the v1 set.

import type { ActionKind } from "../types";
import { actionTier, NO_BRAINER } from "./confidence";

/** The action kinds that may graduate to unattended autopilot execution.
 *  Expanded from 3 to 7 in Phase 2: adds resume_campaign, reallocate_budget,
 *  reallocate_inventory, and adjust_price alongside the original three.
 *  Each kind must still clear all 7 gates (undo branch, approvals, outcomes,
 *  confidence) before it can act unattended.
 *
 *  Note on resume_campaign and reallocate_budget:
 *  Both were added because they have complete undo branches.
 *  reallocate_budget has an autopilot trigger (a DETECTOR_TO_ACTIONS mapping
 *  fires it), so it accrues measured outcomes normally.
 *  resume_campaign now has its autonomous trigger too (autopilot trust UX Slice B):
 *  the sku_stockout_cleared detector maps to resume_campaign via DETECTOR_TO_ACTIONS,
 *  and the RESUME_DETECTORS branch in autopilot.server.ts fires it once the pair is
 *  graduated AND merchant-enabled — so it accrues outcomes and can graduate like
 *  the others. */
export const GRADUATABLE: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "pause_campaign",
  "reduce_campaign_budget",
  "discontinue_sku",
  "resume_campaign",
  "reallocate_budget",
  "reallocate_inventory",
  "adjust_price",
]);

/** Minimum clean approvals required per reversibility class. */
export const MIN_APPROVALS = {
  reversible: 3,
  hard_to_reverse: 10,
  irreversible: 25,
} as const;

/** Minimum net-positive MEASURED outcomes required per reversibility class
 *  (design 2026-06-26 §2.1). The second of the two graduation bars. */
export const MIN_OUTCOMES = {
  reversible: 3,
  hard_to_reverse: 5,
  irreversible: 8,
} as const;

/** Tier confidence floors for graduation (spec §3 table: 75 / 88 / 95). The
 *  stored pair_calibration.graduation_threshold defaults to 75 for every tier
 *  and is raised by too_aggressive rejects; the tier floor guarantees a
 *  hard_to_reverse or irreversible pair can never graduate at the reversible
 *  bar regardless of the stored value. */
export const TIER_GRADUATION_FLOOR = {
  reversible: 75,
  hard_to_reverse: 88,
  irreversible: 95,
} as const;

/** The confidence bar a pair must actually clear: the stored (possibly
 *  reject-raised) threshold, floored by its reversibility tier, capped at 99
 *  (the same cap the rejection RPC applies to raises). */
export function effectiveGraduationThreshold(
  actionKind: ActionKind,
  storedThreshold: number,
): number {
  const floor = TIER_GRADUATION_FLOOR[actionTier(actionKind)];
  const stored = Number.isFinite(storedThreshold) && storedThreshold > 0 ? storedThreshold : floor;
  return Math.min(99, Math.max(stored, floor));
}

/** No-brainer demote-to-ask bar (I8). The three shipped no-brainers unlock at
 *  cold-start conf ~74 (below the 75 tier bar — that is the deliberate
 *  exception), but they are NOT exempt from evidence: once real rejects push
 *  conf below this bar the pair returns to queue-only ("always ask"), and
 *  approvals earn it back. 70 sits under the ~74 cold start and above the
 *  I8 floor of 20. */
export const NO_BRAINER_MIN_CONF = 70;

export interface GraduationVerdictInput {
  detectorId: string;
  actionKind: ActionKind;
  lastConf: number;
  gradThreshold: number;
  cleanApprovals: number;
  consecutiveUndos: number;
  merchantDisabled: boolean;
  onProbation: boolean;
  hasUndoBranch: boolean;
  /** Net-positive measured outcomes (design §2.1). 0 until windows close. */
  netPositiveOutcomes: number;
  /** Sign of the most recently closed outcome (design §2.3). <0 demotes. */
  lastOutcomeSign: -1 | 0 | 1;
}

export interface GraduationVerdict {
  graduated: boolean;
  reason: string;
}

/**
 * Decide whether a (detector, action) pair may act unattended.
 *
 * Gates are checked in order; the first failing condition is returned.
 * ALL seven gates must pass for graduated=true.
 *
 *  1. Kind must be in the graduatable set (GRADUATABLE — 7 kinds as of Phase 2).
 *  2. A working undo branch must exist for the kind (I7).
 *  3. The merchant must not have disabled the pair (or a muted_pair rule is active).
 *  4. The pair must not be on probation (pair_probation_until rule active).
 *  5. No consecutive undos (merchant reversed the last autonomous action).
 *  6. Clean approvals must meet the action's reversibility-tier floor
 *     (MIN_APPROVALS[actionTier]: reversible 3 / hard_to_reverse 10 / irreversible 25).
 *  7. Last confidence must meet or exceed the graduation threshold.
 */
export function graduationVerdict(
  input: GraduationVerdictInput,
): GraduationVerdict {
  if (!GRADUATABLE.has(input.actionKind)) {
    return { graduated: false, reason: "kind not graduatable" };
  }
  if (!input.hasUndoBranch) {
    return { graduated: false, reason: "no undo branch" };
  }
  if (input.merchantDisabled) {
    return { graduated: false, reason: "merchant disabled" };
  }
  if (input.onProbation) {
    return { graduated: false, reason: "on probation" };
  }
  if (input.consecutiveUndos !== 0) {
    return { graduated: false, reason: "recent undo" };
  }
  // Measured-loss demotion (design §2.3): the most recent closed outcome lost
  // money. Applies to ALL pairs, including shipped no-brainers — reality can
  // revoke trust without waiting for a merchant undo.
  if (input.lastOutcomeSign < 0) {
    return { graduated: false, reason: "recent measured loss" };
  }
  // These three conservative pause pairs ship with Calderyn. They are
  // auto-unlocked from day one, but still sit behind the shop-level Autopilot
  // switch, per-feature merchant switch, live rules, undo support, guardrails,
  // freshness checks, and detector-specific execution preconditions.
  //
  // The unlock is NOT evidence-proof (I8): a cold no-brainer scores ~74 and
  // stays unlocked, but once the merchant's rejects push conf below
  // NO_BRAINER_MIN_CONF the pair demotes to queue-only ("always ask", never
  // silent — the alert keeps firing and the I8 floor keeps it visible).
  // Approvals raise conf and re-unlock it.
  if (NO_BRAINER.has(`${input.detectorId}:${input.actionKind}`)) {
    if (input.lastConf < NO_BRAINER_MIN_CONF) {
      return { graduated: false, reason: "below confidence bar" };
    }
    return { graduated: true, reason: "shipped no-brainer" };
  }
  if (input.cleanApprovals < MIN_APPROVALS[actionTier(input.actionKind)]) {
    return { graduated: false, reason: "needs more approvals" };
  }
  // Second bar (design §2.1): the dollars must prove it, not just the clicks.
  if (input.netPositiveOutcomes < MIN_OUTCOMES[actionTier(input.actionKind)]) {
    return { graduated: false, reason: "needs proven results" };
  }
  // The confidence bar: the stored (possibly reject-raised) threshold, floored
  // by the reversibility tier (spec §3: 75 / 88 / 95) — a riskier kind can
  // never graduate at the reversible bar.
  if (input.lastConf < effectiveGraduationThreshold(input.actionKind, input.gradThreshold)) {
    return { graduated: false, reason: "below confidence bar" };
  }
  return { graduated: true, reason: "all gates passed" };
}
