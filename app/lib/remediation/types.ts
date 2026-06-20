// app/lib/remediation/types.ts
// Pure types for the product-economics remediation engine. No imports from
// server modules — this file (and rank.ts / synopsis.ts) must stay importable
// from both client and server, and from future autopilot code.

import type { DetectorId } from "../types";

/** Strategic moves the engine can recommend. Phase 1 surfaces all of these as
 *  advisory guidance; only `snooze` is executable today (the others gain
 *  executors in Phases 2–3). */
export type MoveKind =
  | "discontinue" // stop reordering / archive the product
  | "cut_ads" // pause or cut the ad spend driving the loss
  | "reallocate_to_winner" // move ad budget to a higher-margin product
  | "fix_returns" // address the return driver before scaling
  | "review_pricing" // raise price / renegotiate COGS
  | "snooze"; // defer the alert

export interface StrategicMove {
  kind: MoveKind;
  /** Projected 30-day dollars recovered/gained, in cents. Drives the ranking. */
  dollarImpactCents: number;
  /** Live executor for this move, or null when the move is advisory only.
   *  Phase 1: only "snooze" → "snooze_alert". Phase 2 adds "discontinue_sku" on
   *  the discontinue move. Phase 3 will add the Meta budget-shift executor; keep
   *  this union open so later phases extend it without breaking existing values. */
  executor: "snooze_alert" | "discontinue_sku" | null;
  /** Short human label for the move (UI). */
  label: string;
}

export interface RemediationInput {
  detectorId: DetectorId;
  /** alert.dollar_impact — already in cents at the DTO boundary. */
  dollarImpactCents: number;
  /** Evidence coerced to numbers (USD dollars), nulls for missing keys. */
  evidence: Record<string, number | null>;
}

export interface RemediationPlan {
  /** Ranked desc by dollarImpactCents, deterministic tie-break. snooze is last. */
  moves: StrategicMove[];
  /** The top non-snooze move, or null when only snooze applies. */
  recommended: MoveKind | null;
  /** net contribution/unit at zero ad spend ≤ 0 → the product can't be fixed by
   *  tuning ads; discontinue is the only real lever. */
  structurallyDead: boolean;
}
