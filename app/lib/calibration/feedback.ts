/**
 * Pure reject-reason taxonomy and plain-language reflection.
 * No I/O, no server imports.
 */

import type { ActionKind } from "../types";
import { DETECTOR_LABELS, ACTION_VERBS } from "../labels";

export type RejectReason =
  | "too_aggressive"
  | "wrong_timing"
  | "not_enough_data"
  | "i_handle_this"
  | "other";

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
  const verbRaw = ACTION_VERBS[actionKind];
  const verb = verbRaw.toLowerCase();

  switch (reason) {
    case "too_aggressive":
      return `Got it. I'll be gentler with ${verb} on ${label} and keep the size smaller.`;
    case "wrong_timing":
      return `Thanks. I'll factor in timing before I suggest ${verb} on ${label} again.`;
    case "not_enough_data":
      return `Fair. I'll wait for stronger proof before I suggest ${verb} on ${label}, and keep asking you first for a while.`;
    case "i_handle_this":
      return `Got it. I'll leave ${verb} on ${label} to you. Hand it back any time from Learned rules.`;
    case "other":
      return `Noted. Pick a reason category next time so I can learn more precisely.`;
  }
}
