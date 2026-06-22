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

// Plain-language gerund phrase per action, in the agent's first-person "I'll
// handle ___ for you" voice. Falls back to a lowercased action label for any
// kind not listed (still grammatical: "I'll handle reallocate budget for you").
const ACTION_HANDLE_PHRASE: Partial<Record<ActionKind, string>> = {
  pause_campaign: "pausing campaigns that are losing money",
  reduce_campaign_budget: "trimming budgets on campaigns that aren't pulling their weight",
  resume_campaign: "resuming campaigns once they're worth running again",
  reallocate_budget: "shifting budget toward the campaigns that are working",
  exclude_geo: "trimming the regions that aren't converting",
  reallocate_inventory: "moving stock to where it's selling",
  create_po_draft: "drafting restock orders before you run out",
};

/**
 * Positive-feedback counterpart to `reflection`: the agent's one-line
 * acknowledgement when a merchant APPROVES a (detector, action) pair. First
 * person, plain language, no em/en dashes. Always returns a non-empty string.
 *
 * Example tone: "Got it. I'll handle pausing campaigns that are losing money
 * for you from now on."
 */
export function approveReflection(detectorId: string, actionKind: ActionKind): string {
  const phrase =
    ACTION_HANDLE_PHRASE[actionKind] ??
    (ACTION_LABELS[actionKind]?.toLowerCase() ?? "this");
  return `Got it. I'll handle ${phrase} for you from now on.`;
}
