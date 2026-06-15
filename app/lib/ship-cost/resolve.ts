import type { OrderSignals, ShipCostResult } from "./types";

export function resolveOrderShipCost(s: OrderSignals): ShipCostResult {
  if (s.manualOverrideCents != null)
    return { cents: s.manualOverrideCents, source: "manual", confidence: "high" };
  if (s.invoiceLineCents != null)
    return { cents: s.invoiceLineCents, source: "actual_invoice", confidence: "high" };
  if (s.eventParsedCents != null)
    return { cents: s.eventParsedCents, source: "actual_event", confidence: "med" };
  if (s.allocatedCents != null) {
    const confidence: ShipCostResult["confidence"] =
      s.allocationCoverage === "full" ? "high"
      : s.allocationCoverage === "none" ? "low"
      : "med";
    return { cents: s.allocatedCents, source: "reconciled", confidence };
  }
  if (s.modeledCents != null)
    return { cents: s.modeledCents, source: "modeled", confidence: "low" };
  return { cents: s.fallbackCents, source: "fallback", confidence: "low" };
}
