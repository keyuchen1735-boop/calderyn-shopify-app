// Single source of truth for action kinds with a working undo branch in
// app/lib/actions/undo.server.ts. Graduation gate 2 (I7) requires this — a pair
// can only act unattended if Calderyn can take the action back. Keep in lockstep
// with undo.server.ts's reversal branches.
import type { ActionKind } from "../types";

export const HAS_UNDO_BRANCH: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "pause_campaign",
  "resume_campaign",
  "reduce_campaign_budget",
  "reallocate_budget",
  "reallocate_inventory",
  "discontinue_sku",
  "adjust_price",
]);
