import type { ActionKind } from "./types";

// Actions that recover the at-stake dollars when they succeed: stopping waste
// (pause/reduce/reallocate budget, exclude a geo) or covering a shortfall
// (reorder PO, move inventory). Neutral actions — snoozing an alert or resuming
// a campaign — recover nothing, so they don't count toward Recovered impact.
const VALUE_RECOVERING: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "pause_campaign",
  "reduce_campaign_budget",
  "reallocate_budget",
  "exclude_geo",
  "reallocate_inventory",
  "create_po_draft",
]);

/**
 * Dollars (in cents) a successfully executed action recovers, given the
 * at-stake impact of the alert it resolved. Used to populate
 * action_audit.dollar_impact_at_exec so the Recovered-impact total reflects
 * what each action actually clawed back. Clamped to a non-negative integer.
 */
export function recoveredCentsForAction(action: ActionKind, atStakeCents: number): number {
  if (!VALUE_RECOVERING.has(action)) return 0;
  return Math.max(0, Math.round(atStakeCents));
}
