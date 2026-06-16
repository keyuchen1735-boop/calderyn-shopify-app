import type { ShipCostSource } from "./types";

export type BadgeTone = "success" | "info" | "attention" | "warning";

export interface ShipCostBadge {
  label: string;
  tone: BadgeTone;
}

/** Merchant-facing label + Polaris Badge tone for a resolved ship-cost source.
 * null when the order/SKU has no resolved source yet. */
export function shipCostBadge(source: ShipCostSource | null): ShipCostBadge | null {
  switch (source) {
    case "actual_invoice":
    case "actual_event":
      return { label: "Actual", tone: "success" };
    case "reconciled":
      return { label: "Reconciled", tone: "info" };
    case "manual":
      return { label: "Manual", tone: "info" };
    case "modeled":
      return { label: "Modeled", tone: "attention" };
    case "fallback":
      return { label: "Estimate", tone: "warning" };
    default:
      return null;
  }
}
