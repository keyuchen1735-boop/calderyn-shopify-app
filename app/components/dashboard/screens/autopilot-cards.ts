import { detectorLabel } from "~/lib/labels";

// Actions that grow revenue (scale spend, reorder stock) frame their dollar
// figure as money earned; every other queued action stops a loss, so its
// figure is money kept. Unknown/future kinds default to "Keeps".
const GROWTH_ACTIONS = new Set<string>([
  "increase_campaign_budget",
  "reallocate_budget",
  "reallocate_spend_sku",
  "create_po_draft",
]);

/** Verb that frames a proposal's dollar impact as a benefit. */
export function moneyVerb(actionKind: string): "Keeps" | "Earns" {
  return GROWTH_ACTIONS.has(actionKind) ? "Earns" : "Keeps";
}

/**
 * The two lines of a proposal's "why": the plain-language problem category
 * (always present) and the alert narrative (null when the alert has none, so
 * the card can render the category alone).
 */
export function reasonLines(
  reasoning: string | null | undefined,
  detectorId: string,
): { category: string; narrative: string | null } {
  const narrative = typeof reasoning === "string" ? reasoning.trim() : "";
  return {
    category: detectorLabel(detectorId),
    narrative: narrative.length > 0 ? narrative : null,
  };
}
