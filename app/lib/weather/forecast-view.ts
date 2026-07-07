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

/** Coarse sky condition for a region's 3-day window, for icon-led cards. */
export type WeatherCondition = "snow" | "rain" | "showers" | "clear";

// Derived from the 3-day precip/snow totals we already fetch; switch to
// Open-Meteo's daily weathercode if cloud/fog nuance ever matters.
export function conditionFor(f: Pick<RegionForecast, "precipMm" | "snowCm">): WeatherCondition {
  if (f.snowCm >= 1) return "snow";
  if (f.precipMm >= 10) return "rain";
  if (f.precipMm >= 2) return "showers";
  return "clear";
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
