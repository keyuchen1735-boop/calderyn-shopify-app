// Weather-merchandising affinity: decide which products to float to the top of
// the storefront given the shop region's current weather. Self-contained (its own
// "niceness" heuristic) so it does not couple to the demand-scoring model.
import type { RegionForecast } from "./score";

export type WeatherCondition = "sun" | "storm" | "neutral";
export const WEATHER_CONDITIONS: readonly WeatherCondition[] = ["sun", "storm", "neutral"];

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

// "Niceness" of the weather in [-1,1]: warm, dry, bright, snow-free = +1.
function forecastNiceness(f: RegionForecast): number {
  const gTemp = clamp((f.avgTempC - 12) / 13, -1, 1);
  const gDry = clamp(1 - f.precipMm / 15, -1, 1);
  const gSun = clamp((f.avgDaylightH - 11) / 3, -1, 1);
  const gSnow = -clamp(f.snowCm / 10, 0, 1);
  return clamp(0.45 * gTemp + 0.3 * gDry + 0.15 * gSun + 0.1 * gSnow, -1, 1);
}

const CONDITION_THRESHOLD = 0.3;

/** What the weather favors right now: sun (nice), storm (bad), or neutral (mild). */
export function weatherCondition(f: RegionForecast): WeatherCondition {
  const g = forecastNiceness(f);
  if (g >= CONDITION_THRESHOLD) return "sun";
  if (g <= -CONDITION_THRESHOLD) return "storm";
  return "neutral";
}

const SUN_CUES = ["swim","bikini","beach","sun","shorts","sandal","flip-flop","tank","patio","bbq","grill","garden","pool","tan","summer","hat","cap","outdoor","picnic","cooler","hydration","hike","cycling","tee","linen"];
const STORM_CUES = ["umbrella","rain","coat","jacket","parka","boot","wellington","heater","sweater","hoodie","thermal","snow","waterproof","scarf","glove","mitten","beanie","wool","fleece","blanket","indoor","cozy","winter","insulated"];

function countCues(haystack: string, cues: string[]): number {
  let n = 0;
  for (const cue of cues) if (haystack.includes(cue)) n += 1;
  return n;
}

/** Classify a product by its title + category + tags; stronger cue wins, else
 *  neutral. The TITLE is included because real catalogs carry the weather signal
 *  in the product name ("Cascade Rain Shell", "Switchback Cap") while their
 *  category/tags are often generic taxonomy ("outerwear", "accessories"). */
export function productAffinity(
  category: string | null | undefined,
  tags: readonly string[] | null | undefined,
  title?: string | null,
): WeatherCondition {
  const haystack = [title ?? "", category ?? "", ...(tags ?? [])].join(" ").toLowerCase();
  if (!haystack.trim()) return "neutral";
  const sun = countCues(haystack, SUN_CUES);
  const storm = countCues(haystack, STORM_CUES);
  if (sun > storm) return "sun";
  if (storm > sun) return "storm";
  return "neutral";
}

export interface WeatherSortable {
  title?: string | null;
  category?: string | null;
  tags?: readonly string[] | null;
}

/** Stably reorder so products matching the condition lead; neutral = unchanged. */
export function boostByWeather<T extends WeatherSortable>(
  products: readonly T[],
  condition: WeatherCondition,
): T[] {
  if (condition === "neutral") return [...products];
  const matches: T[] = [];
  const rest: T[] = [];
  for (const p of products) {
    if (productAffinity(p.category, p.tags, p.title) === condition) matches.push(p);
    else rest.push(p);
  }
  return [...matches, ...rest];
}
