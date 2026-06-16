// Weight-based ship-cost model: a low-confidence estimate of an order's true
// shipping cost from its packed weight and destination zone. Used by
// resolveOrderShipCost's `modeled` tier (confidence "low") when there is no
// manual override, carrier invoice, or period-total allocation for the order.
//
// Returns null when weight is unknown, so the resolver falls through to the
// next tier instead of fabricating a cost from missing data.

// Rough blended domestic parcel rate ($/kg), in cents. Deliberately a
// low-confidence default — the resulting estimate is tagged source="modeled",
// confidence="low". TODO: make shop-configurable (shop_settings) in a follow-up.
export const DEFAULT_SHIP_RATE_PER_KG_CENTS = 1200;

/**
 * Estimate an order's ship cost (cents) = ratePerKg × weight(kg) × zoneMultiplier.
 * `gramsSum` is the order's total packed weight; `zoneMultiplier` comes from
 * zoneMultiplier(classifyZone(shopCountry, orderCountry)). Returns null when the
 * weight is missing/non-positive.
 */
export function modelOrderShipCost(
  gramsSum: number | null,
  zoneMultiplier: number,
  ratePerKgCents: number = DEFAULT_SHIP_RATE_PER_KG_CENTS,
): number | null {
  if (gramsSum == null || !Number.isFinite(gramsSum) || gramsSum <= 0) return null;
  return Math.round((gramsSum / 1000) * ratePerKgCents * zoneMultiplier);
}
