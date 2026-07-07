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

/** Demand tier cut-points — single source for the card pills AND the map
 *  marker emphasis, so retuning thresholds can't desync the two. */
export type DemandTier = "high" | "up" | "typical";

export function demandTier(score: number): DemandTier {
  if (score >= 0.45) return "high";
  if (score >= 0.2) return "up";
  return "typical";
}

/** The favorability score in plain shopper language, for the region cards. */
export function demandLabel(score: number): { label: string; tone: "success" | "neutral" } {
  const tier = demandTier(score);
  if (tier === "high") return { label: "More shoppers online", tone: "success" };
  if (tier === "up") return { label: "Slightly more online", tone: "neutral" };
  return { label: "Typical demand", tone: "neutral" };
}

// Harsher weather ranks first; a region with no forecast ranks mildest.
const CONDITION_RANK: Record<WeatherCondition, number> = {
  snow: 3,
  rain: 2,
  showers: 1,
  clear: 0,
};

/** Order budget moves for the panel: soonest day first, then harsher
 *  destination weather, then bigger moves. Pure — does not mutate. */
export function sortMoves<
  T extends { expiresOn: string; destRegion: string; amountCents: number },
>(moves: readonly T[], cond: ReadonlyMap<string, WeatherCondition>): T[] {
  const rank = (m: T): number => {
    const c = cond.get(m.destRegion);
    return c ? CONDITION_RANK[c] : -1;
  };
  return [...moves].sort(
    (a, b) =>
      a.expiresOn.localeCompare(b.expiresOn) ||
      rank(b) - rank(a) ||
      b.amountCents - a.amountCents,
  );
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
