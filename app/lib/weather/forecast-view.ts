// Pure shaping of region forecasts into the view the Weather segments tab
// renders: one card per region (forecast numbers + favorability score) plus
// which region is the merchant's home. Regions with no forecast are omitted —
// the UI shows what we know, never fabricated zeros.
import type { RegionCode } from "../ads/actions";
import { favorability, type RegionForecast } from "./score";
import { REGION_CENTROIDS, nearestRegion, type MerchantLocation } from "./regions";

export interface RegionForecastVM extends RegionForecast {
  region: RegionCode;
  score: number;
}

export interface ForecastView {
  regions: RegionForecastVM[];
  homeRegion: RegionCode | null;
}

export function buildForecastView(
  forecasts: Map<RegionCode, RegionForecast>,
  merchant: MerchantLocation | null,
): ForecastView {
  const regions: RegionForecastVM[] = [];
  for (const { region } of REGION_CENTROIDS) {
    const f = forecasts.get(region);
    if (!f) continue;
    regions.push({ region, ...f, score: favorability(f) });
  }
  return {
    regions,
    homeRegion: merchant ? nearestRegion(merchant.lat, merchant.lon) : null,
  };
}
