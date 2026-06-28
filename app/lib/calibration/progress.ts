// Pure two-bar graduation progress for merchant-facing display. Combines the
// approval bar (MIN_APPROVALS) and the measured-outcome bar (MIN_OUTCOMES) so
// both surfaces render "approved X/N AND made money Y/M" identically.
import type { ActionKind } from "../types";
import { actionTier } from "./confidence";
import { MIN_APPROVALS, MIN_OUTCOMES } from "./graduation";

export interface GraduationProgress {
  approvals: number;
  approvalsNeeded: number;
  outcomes: number;
  outcomesNeeded: number;
  /** Both bars met (confidence/undo/probation gates handled elsewhere). */
  proven: boolean;
}

export function graduationProgress(
  actionKind: ActionKind,
  cleanApprovals: number,
  netPositiveOutcomes: number,
): GraduationProgress {
  const tier = actionTier(actionKind);
  const approvalsNeeded = MIN_APPROVALS[tier];
  const outcomesNeeded = MIN_OUTCOMES[tier];
  const approvals = Math.max(0, cleanApprovals);
  const outcomes = Math.max(0, netPositiveOutcomes);
  return {
    approvals,
    approvalsNeeded,
    outcomes,
    outcomesNeeded,
    proven: approvals >= approvalsNeeded && outcomes >= outcomesNeeded,
  };
}
