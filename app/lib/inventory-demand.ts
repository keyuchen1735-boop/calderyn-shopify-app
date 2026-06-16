// Pure derivation from a v_sku_regional_demand row to the SKU DTO's demand +
// suggested-transfer fields. Presentation policy lives HERE (not SQL) so both
// surfaces — and the unit tests — share one definition of "mismatch":
// the main demand region holds less than 7 days of its own demand and stock
// exists elsewhere to cover (part of) the gap.

import type { SkuDemand, SkuLocationDetail, SuggestedTransfer } from "./types";

/**
 * Raw row shape from PostgREST. Uncast numerics arrive as strings; int-cast
 * columns arrive as numbers — both coerced via Number() at the call site.
 */
export interface SkuDemandViewRow {
  sku_id: string;
  main_demand_region: string;
  demand_units_30d: string | number;
  daily_demand: string | number;
  demand_share: string | number;
  stock_in_region: string | number;
  dest_location_external_id: string | null;
  dest_location_name: string | null;
  src_location_external_id: string | null;
  src_location_name: string | null;
  src_available: string | number;
  inventory_item_id: string | null;
  locations_detail:
    | Array<{
        external_id: string;
        name: string;
        region: string | null;
        available: number;
        active?: boolean;
      }>
    | null;
}

/**
 * Human label for a SKU's main-region demand. Replaces the cryptic "10/30d"
 * with "10 units sold/30d" so the column reads as sales volume over the
 * trailing 30 days. Shared by both inventory surfaces (extension SKUs table +
 * dashboard Inventory screen) so the wording can't drift between them.
 */
export function formatDemandUnits(units30d: number): string {
  const noun = units30d === 1 ? "unit" : "units";
  return `${units30d.toLocaleString("en-US")} ${noun} sold/30d`;
}

/**
 * Severity level for a SKU's trailing-30-day return rate (0..1), or null when
 * it's healthy. Thresholds: > 25% critical, > 10% caution. Shared by both
 * inventory surfaces so the flag can't drift; each surface maps the level to its
 * own colour system (Polaris tone vs dashboard CSS var).
 */
export function returnRateLevel(rate: number): "critical" | "caution" | null {
  if (rate > 0.25) return "critical";
  if (rate > 0.1) return "caution";
  return null;
}

export function demandFromRow(r: SkuDemandViewRow): SkuDemand {
  return {
    region: r.main_demand_region,
    units_30d: Number(r.demand_units_30d ?? 0),
    share: Number(r.demand_share ?? 0),
    stock_in_region: Number(r.stock_in_region ?? 0),
  };
}

export function locationsDetailFromRow(r: SkuDemandViewRow): SkuLocationDetail[] {
  return (r.locations_detail ?? []).map((l) => ({
    id: l.external_id,
    name: l.name,
    region: l.region,
    available: Number(l.available ?? 0),
    // Older payloads predate the 'active' key; treat them as active.
    active: Boolean(l.active ?? true),
  }));
}

export function suggestedTransferFromRow(r: SkuDemandViewRow): SuggestedTransfer | null {
  const dailyDemand = Number(r.daily_demand ?? 0);
  if (!(dailyDemand > 0)) return null;
  const shortfall = Math.ceil(dailyDemand * 7 - Number(r.stock_in_region ?? 0));
  if (!(shortfall >= 1)) return null;
  if (!r.inventory_item_id || !r.dest_location_external_id || !r.src_location_external_id) {
    return null;
  }
  if (r.dest_location_external_id === r.src_location_external_id) return null;
  const delta = Math.min(shortfall, Number(r.src_available ?? 0));
  if (!(delta >= 1)) return null;
  return {
    inventory_item_id: r.inventory_item_id,
    from_location_id: r.src_location_external_id,
    from_location_name: r.src_location_name ?? r.src_location_external_id,
    to_location_id: r.dest_location_external_id,
    to_location_name: r.dest_location_name ?? r.dest_location_external_id,
    recommended_delta: delta,
  };
}
