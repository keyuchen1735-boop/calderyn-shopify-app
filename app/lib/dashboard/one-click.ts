// One-click safety predicate shared by the Home decision deck and the
// Autopilot screen, so the two surfaces can never disagree about which kinds
// execute directly and which route to a review step. Kinds outside this list
// need dialog inputs (adjust_price shows a price, create_po_draft asks
// quantity/cost) — those review steps live on the alert's own detail.
import type { ActionKind } from "~/components/dashboard/context";
import type { AlertVM } from "~/components/dashboard/view-models";

export const ONE_CLICK_KINDS: ActionKind[] = [
  "pause_campaign",
  "resume_campaign",
  "reduce_campaign_budget",
  "increase_campaign_budget",
  "exclude_geo",
  "reallocate_inventory",
  "discontinue_sku",
  "reallocate_spend_sku",
];

export function oneClickKind(k: string): k is ActionKind {
  return (ONE_CLICK_KINDS as string[]).includes(k);
}

export const CAMPAIGN_KINDS: ReadonlySet<string> = new Set([
  "pause_campaign",
  "resume_campaign",
  "reduce_campaign_budget",
  "increase_campaign_budget",
  "exclude_geo",
]);

/** True when the client can actually run `kind` for this alert right here:
 *  a whitelisted kind, the alert loaded, and (for campaign kinds) a resolvable
 *  campaign id. Everything else deserves a "Review" affordance — never a
 *  button that can't succeed. */
export function canOneClickAlert(alert: AlertVM | undefined, kind: string): boolean {
  if (!oneClickKind(kind)) return false;
  if (!alert) return false;
  if (CAMPAIGN_KINDS.has(kind) && !alert.campaign_id) return false;
  if (kind === "exclude_geo" && !alert.region) return false;
  return true;
}
