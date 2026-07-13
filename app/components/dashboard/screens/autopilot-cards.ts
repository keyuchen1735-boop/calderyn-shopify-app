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

/** One plain-English sentence for a queue row: what Calderyn wants to do to
 *  which subject. Unknown kinds fall back to "<feature label>: <subject>" at
 *  the call site (this returns null so the caller keeps that decision). */
const SAY_TEMPLATES: Record<string, (subject: string) => string> = {
  create_po_draft: (s) => `Reorder ${s} before it runs out`,
  pause_campaign: (s) => `Pause ads for ${s}`,
  resume_campaign: (s) => `Resume ads for ${s}`,
  increase_campaign_budget: (s) => `Add budget to ${s}`,
  reduce_campaign_budget: (s) => `Trim budget on ${s}`,
  exclude_geo: (s) => `Stop ads where ${s} is out of stock`,
  reallocate_inventory: (s) => `Move ${s} stock where it sells`,
  reallocate_budget: (s) => `Shift budget toward ${s}`,
  reallocate_spend_sku: (s) => `Shift ad spend toward ${s}`,
  adjust_price: (s) => `Adjust the price of ${s}`,
  raise_free_ship_threshold: (s) => `Raise the free-shipping bar on ${s}`,
  snooze: (s) => `Snooze ${s}`,
};

export function sayLine(actionKind: string, subject: string): string | null {
  const tpl = SAY_TEMPLATES[actionKind];
  return tpl ? tpl(subject) : null;
}

/** Queue grouping for the trainer: similar moves cluster under one header so
 *  nine cards read as three decisions. Keys double as render order. */
export type MoveGroupKey = "protect" | "restock" | "scale" | "price" | "other";

export const MOVE_GROUP_ORDER: MoveGroupKey[] = ["protect", "restock", "scale", "price", "other"];

export const MOVE_GROUPS: Record<MoveGroupKey, { label: string; icon: string }> = {
  protect: { label: "Stop wasted spend", icon: "shield" },
  restock: { label: "Restock", icon: "box" },
  scale: { label: "Scale winners", icon: "trendUp" },
  price: { label: "Pricing", icon: "target" },
  other: { label: "Other moves", icon: "bolt" },
};

const GROUP_BY_ACTION: Record<string, MoveGroupKey> = {
  pause_campaign: "protect",
  exclude_geo: "protect",
  reduce_campaign_budget: "protect",
  snooze: "protect",
  create_po_draft: "restock",
  reallocate_inventory: "restock",
  increase_campaign_budget: "scale",
  resume_campaign: "scale",
  reallocate_budget: "scale",
  reallocate_spend_sku: "scale",
  adjust_price: "price",
  raise_free_ship_threshold: "price",
  exclude_sku_free_ship: "price",
};

export function moveGroupFor(actionKind: string): MoveGroupKey {
  return GROUP_BY_ACTION[actionKind] ?? "other";
}
