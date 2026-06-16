export type ShipCostSource =
  | "actual_invoice"
  | "actual_event"
  | "reconciled"
  | "modeled"
  | "fallback"
  | "manual";

export type ShipCostConfidence = "high" | "med" | "low";

export interface ShipCostResult {
  cents: number;
  source: ShipCostSource;
  confidence: ShipCostConfidence;
}

/** Per-order candidate signals, highest-fidelity first. Undefined/null = absent. */
export interface OrderSignals {
  manualOverrideCents?: number | null;
  invoiceLineCents?: number | null;
  /** Only populated if the parse already reconciled under the period total. */
  eventParsedCents?: number | null;
  /** Mode-B allocation result for this order; null when no period total exists. */
  allocatedCents?: number | null;
  /** Generic per-zone default when no period total at all. */
  modeledCents?: number | null;
  /** Flat floor (period_total / orders, or category default). Always present. */
  fallbackCents: number;
  /** Feature coverage behind allocatedCents, drives confidence. */
  allocationCoverage?: "full" | "partial" | "none";
}
