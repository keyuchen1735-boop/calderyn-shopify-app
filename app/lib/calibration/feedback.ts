/**
 * Pure reject-reason taxonomy and plain-language reflection.
 * No I/O, no server imports.
 */

import type { ActionKind, RejectReason } from "../types";
import { DETECTOR_LABELS, ACTION_LABELS } from "../labels";

export type { RejectReason };

export interface RejectEffect {
  betaDelta: number;
  gradDelta: number;
  mute: boolean;
  ruleKind: "pair_dollar_cap" | "pair_probation_until" | "muted_pair" | null;
}

const REJECT_EFFECTS: Record<RejectReason, RejectEffect> = {
  too_aggressive:   { betaDelta: 0.5, gradDelta: 5, mute: false, ruleKind: "pair_dollar_cap" },
  wrong_timing:     { betaDelta: 0.5, gradDelta: 0, mute: false, ruleKind: null },
  not_enough_data:  { betaDelta: 1,   gradDelta: 2, mute: false, ruleKind: "pair_probation_until" },
  i_handle_this:    { betaDelta: 0,   gradDelta: 0, mute: true,  ruleKind: "muted_pair" },
  other:            { betaDelta: 1,   gradDelta: 0, mute: false, ruleKind: null },
};

export function rejectEffect(reason: RejectReason): RejectEffect {
  return REJECT_EFFECTS[reason];
}

export function reflection(
  reason: RejectReason,
  detectorId: string,
  actionKind: ActionKind,
): string {
  const label = DETECTOR_LABELS[detectorId as keyof typeof DETECTOR_LABELS] ?? detectorId;
  const action = ACTION_LABELS[actionKind].toLowerCase();

  switch (reason) {
    case "too_aggressive":
      return `Got it. I'll be gentler on ${label} and keep any ${action} smaller.`;
    case "wrong_timing":
      return `Thanks. I'll factor in timing before I suggest a ${action} for ${label} again.`;
    case "not_enough_data":
      return `Fair. I'll wait for stronger proof on ${label}, and keep asking you first for a while.`;
    case "i_handle_this":
      return `Got it. I'll leave ${label} to you. Hand it back any time from Learned rules.`;
    case "other":
      return `Noted. Pick a reason category next time so I can learn more precisely.`;
  }
}
