// Pure derivation from a v_sku_regional_demand row to the SKU DTO's demand +
// suggested-transfer fields. Presentation policy lives HERE (not SQL) so both
// surfaces — and the unit tests — share one definition of "mismatch":
// the main demand region holds less than 7 days of its own demand and stock
// exists elsewhere to cover (part of) the gap.

import type {
  SkuAffinityItem,
  SkuDemand,
  SkuLocationDetail,
  SuggestedTransfer,
} from "./types";

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

const MS_PER_DAY = 86_400_000;

/**
 * Calendar date a SKU is projected to hit zero, as an ISO `YYYY-MM-DD` string,
 * or null when no meaningful date exists.
 *
 * Returns null when `velocity <= 0` (no recent sales → days-of-cover isn't
 * meaningful; mirrors the `hasSales` gate the surfaces already use) or when
 * `daysOfCover` is non-finite (guards against an Invalid Date / RangeError).
 *
 * Presentation policy lives HERE, not in SQL, so both inventory surfaces and
 * the unit tests share one definition. The date is computed in UTC, so it can
 * read ±1 day off the merchant's local calendar — acceptable for a projection,
 * which is why surfaces render it with a "~" prefix.
 */
export function projectedStockoutDate(
  daysOfCover: number,
  velocity: number,
  now = new Date(),
): string | null {
  if (!(velocity > 0)) return null;
  if (!Number.isFinite(daysOfCover)) return null;
  const target = new Date(now.getTime() + daysOfCover * MS_PER_DAY);
  return target.toISOString().slice(0, 10);
}

/**
 * Render a `projectedStockoutDate` ISO string as a compact label, e.g.
 * "Jun 19". The year is appended only when the projection lands outside the
 * current year (a 999-day-cover SKU projects years out, where a bare "Mar 5"
 * would mislead). Parsed and formatted in UTC so the displayed calendar day
 * matches the ISO string regardless of the viewer's timezone. Surfaces add
 * their own "~" approximation prefix.
 */
export function formatStockoutDate(iso: string, now = new Date()): string {
  const date = new Date(`${iso}T00:00:00Z`);
  const sameYear = iso.slice(0, 4) === String(now.getUTCFullYear());
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    timeZone: "UTC",
  });
}

/** Raw row shape from v_sku_affinity (the co-purchased SKU side). */
export interface SkuAffinityViewRow {
  co_sku_id: string;
  co_title: string | null;
  co_sku: string | null;
  co_count: string | number;
  share: string | number;
}

/** Map a v_sku_affinity row to the SkuAffinityItem DTO. Title falls back to the
 * sku code, then the id, so a co-purchased SKU always labels itself. Shared by
 * both inventory surfaces. */
export function affinityFromRow(r: SkuAffinityViewRow): SkuAffinityItem {
  return {
    sku_id: r.co_sku_id,
    title: r.co_title || r.co_sku || r.co_sku_id,
    co_count: Number(r.co_count ?? 0),
    share: Number(r.share ?? 0),
  };
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
