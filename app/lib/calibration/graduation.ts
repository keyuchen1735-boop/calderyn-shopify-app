// Pure graduation-verdict logic for Calderyn Calibration (Slice 5, Task 1).
// No I/O — imports only types. The 7 gates from spec I3/I7 + the v1 set.

import type { ActionKind } from "../types";

/** The action kinds that may graduate in v1 (both reversible campaign actions). */
export const GRADUATABLE_V1: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "pause_campaign",
  "reduce_campaign_budget",
]);

/** Minimum clean approvals required per reversibility class. */
export const MIN_APPROVALS = {
  reversible: 3,
  hard_to_reverse: 10,
  irreversible: 25,
} as const;

export interface GraduationVerdictInput {
  actionKind: ActionKind;
  lastConf: number;
  gradThreshold: number;
  cleanApprovals: number;
  consecutiveUndos: number;
  merchantDisabled: boolean;
  onProbation: boolean;
  hasUndoBranch: boolean;
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
 *  1. Kind must be in the v1 graduatable set (pause_campaign, reduce_campaign_budget).
 *  2. A working undo branch must exist for the kind (I7).
 *  3. The merchant must not have disabled the pair (or a muted_pair rule is active).
 *  4. The pair must not be on probation (pair_probation_until rule active).
 *  5. No consecutive undos (merchant reversed the last autonomous action).
 *  6. Clean approvals must meet the reversible floor (MIN_APPROVALS.reversible = 3).
 *  7. Last confidence must meet or exceed the graduation threshold.
 */
export function graduationVerdict(
  input: GraduationVerdictInput,
): GraduationVerdict {
  if (!GRADUATABLE_V1.has(input.actionKind)) {
    return { graduated: false, reason: "kind not graduatable in v1" };
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
  if (input.cleanApprovals < MIN_APPROVALS.reversible) {
    return { graduated: false, reason: "needs more approvals" };
  }
  if (input.lastConf < input.gradThreshold) {
    return { graduated: false, reason: "below confidence bar" };
  }
  return { graduated: true, reason: "all gates passed" };
}
