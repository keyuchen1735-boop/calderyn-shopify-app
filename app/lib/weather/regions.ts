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
