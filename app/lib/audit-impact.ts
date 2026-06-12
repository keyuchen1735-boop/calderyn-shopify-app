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

function budgetCents(state: unknown, key?: string): number {
  let obj = state as Record<string, unknown> | null | undefined;
  if (key) obj = (obj?.[key] ?? null) as Record<string, unknown> | null;
  const n = Number(obj?.daily_budget_cents);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Dollars (in cents) a successfully executed NO-ALERT action recovers, derived
 * from its own audited pre/post states. Campaigns-page and dashboard-API
 * actions run without an alert, so there is no at-stake amount to claw back;
 * what they verifiably stop is daily budget: a pause stops the whole daily
 * budget, a reduction stops the delta, a reallocation moves the amount off the
 * wasting source. States are untrusted JSON — malformed shapes recover 0.
 */
export function recoveredCentsFromStates(
  action: ActionKind,
  preState: unknown,
  postState: unknown,
): number {
  if (!VALUE_RECOVERING.has(action)) return 0;
  if (action === "pause_campaign") {
    return Math.max(0, Math.round(budgetCents(preState)));
  }
  if (action === "reduce_campaign_budget") {
    return Math.max(0, Math.round(budgetCents(preState) - budgetCents(postState)));
  }
  if (action === "reallocate_budget") {
    return Math.max(
      0,
      Math.round(budgetCents(preState, "source") - budgetCents(postState, "source")),
    );
  }
  // These kinds (create_po_draft, exclude_geo, reallocate_inventory) have no
  // budget pre/post states to derive from, so they recover $0 here. When
  // executed without an alert (e.g. merchant-initiated inventory relocation)
  // there is no at-stake amount either — recovering $0 by design is correct.
  return 0;
}
