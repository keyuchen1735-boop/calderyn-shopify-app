// Representative population-weighted centroid per coarse RegionCode bucket, used
// to query a single forecast point per region. This is deliberately crude — one
// point stands in for ~12 states — which is acceptable for a marginal-signal
// MVP.
import type { RegionCode } from "../ads/actions";

export interface RegionCentroid {
  region: RegionCode;
  lat: number;
  lon: number;
}

export const REGION_CENTROIDS: readonly RegionCentroid[] = [
  { region: "us-west", lat: 37.34, lon: -121.89 },
  { region: "us-central", lat: 41.88, lon: -87.63 },
  { region: "us-south", lat: 33.75, lon: -84.39 },
  { region: "us-east", lat: 40.71, lon: -74.01 },
];

export interface MerchantLocation {
  lat: number;
  lon: number;
}

/** Narrow a guardrail_config row's merchant_lat/lon pair to a location, or
 * null when unset/half-set. Single source of the narrowing rule — used by the
 * suggest run, the execute sweep, and the forecast route. */
export function merchantLocationFrom(
  row: { merchant_lat?: unknown; merchant_lon?: unknown } | null,
): MerchantLocation | null {
  const lat = Number(row?.merchant_lat);
  const lon = Number(row?.merchant_lon);
  return row?.merchant_lat != null && row?.merchant_lon != null && Number.isFinite(lat) && Number.isFinite(lon)
    ? { lat, lon }
    : null;
}

/** Region whose centroid is closest to the given point. Equirectangular
 * distance is plenty at this granularity (4 buckets, continental US). */
export function nearestRegion(lat: number, lon: number): RegionCode {
  let best = REGION_CENTROIDS[0];
  let bestD = Infinity;
  for (const c of REGION_CENTROIDS) {
    const dx = (lon - c.lon) * Math.cos((lat * Math.PI) / 180);
    const dy = lat - c.lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best.region;
}

/** Forecast query points: one per region, with the merchant's home-region
 * centroid replaced by their exact location when known — their local forecast
 * is a better demand signal for that bucket than the crude centroid. */
export function forecastPoints(merchant: MerchantLocation | null): readonly RegionCentroid[] {
  if (!merchant) return REGION_CENTROIDS;
  const home = nearestRegion(merchant.lat, merchant.lon);
  return REGION_CENTROIDS.map((c) =>
    c.region === home ? { region: home, lat: merchant.lat, lon: merchant.lon } : c,
  );
}
