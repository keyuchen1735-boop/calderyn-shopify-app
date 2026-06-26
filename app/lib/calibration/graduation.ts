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
 *  resume_campaign currently has NO autonomous trigger — no DETECTOR_TO_ACTIONS
 *  mapping and no autopilot branch fires it — so it is graduation-eligible but
 *  dormant: it will never accumulate outcomes and cannot graduate until a resume
 *  trigger is added. It remains in this set (plan-mandated) so the undo branch
 *  and graduation machinery are ready for that future trigger. */
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
  if (NO_BRAINER.has(`${input.detectorId}:${input.actionKind}`)) {
    return { graduated: true, reason: "shipped no-brainer" };
  }
  if (input.cleanApprovals < MIN_APPROVALS[actionTier(input.actionKind)]) {
    return { graduated: false, reason: "needs more approvals" };
  }
  // Second bar (design §2.1): the dollars must prove it, not just the clicks.
  if (input.netPositiveOutcomes < MIN_OUTCOMES[actionTier(input.actionKind)]) {
    return { graduated: false, reason: "needs proven results" };
  }
  if (input.lastConf < input.gradThreshold) {
    return { graduated: false, reason: "below confidence bar" };
  }
  return { graduated: true, reason: "all gates passed" };
}
