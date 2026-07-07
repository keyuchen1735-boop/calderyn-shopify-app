// Weather-merchandising affinity: decide which products to float to the top of
// the storefront given the shop region's current weather. Two halves:
//   weatherCondition(forecast) → what the weather favors right now
//   productAffinity(category, tags) → what a product is for
// and boostByWeather() stably reorders a product list so matching products lead.
// Pure + deterministic so both the cron (classifying regions) and the storefront
// (reordering) share one definition, and it is trivially testable.
import { niceness, type RegionForecast } from "./score";

/** What the weather favors: 'sun' (nice/warm/dry → outdoor & summer goods),
 *  'storm' (cold/wet/dark → rain, warmth & indoor goods), or 'neutral'. */
export type WeatherCondition = "sun" | "storm" | "neutral";

// Only commit to a direction when the weather is clearly one way; mild weather is
// neutral (no merchandising change), matching the "weather is a secondary signal"
// stance of the demand model.
const CONDITION_THRESHOLD = 0.3;

export function weatherCondition(f: RegionForecast): WeatherCondition {
  const g = niceness(f);
  if (g >= CONDITION_THRESHOLD) return "sun";
  if (g <= -CONDITION_THRESHOLD) return "storm";
  return "neutral";
}

// Substring keyword cues on a product's category (Shopify productType) + tags.
// Deliberately broad, lower-cased; a product that hits neither (or both equally)
// is neutral and never reordered.
const SUN_CUES = [
  "swim", "bikini", "beach", "sun", "shorts", "sandal", "flip-flop", "tank",
  "patio", "bbq", "grill", "garden", "pool", "tan", "summer", "hat", "cap",
  "outdoor", "picnic", "cooler", "hydration", "hike", "cycling", "tee", "linen",
];
const STORM_CUES = [
  "umbrella", "rain", "coat", "jacket", "parka", "boot", "wellington", "heater",
  "sweater", "hoodie", "thermal", "snow", "waterproof", "scarf", "glove", "mitten",
  "beanie", "wool", "fleece", "blanket", "indoor", "cozy", "winter", "insulated",
];

function countCues(haystack: string, cues: string[]): number {
  let n = 0;
  for (const cue of cues) if (haystack.includes(cue)) n += 1;
  return n;
}

/** Classify a product by its category + tags. Returns the stronger cue direction,
 *  or 'neutral' on a tie or no cue. */
export function productAffinity(
  category: string | null | undefined,
  tags: readonly string[] | null | undefined,
): WeatherCondition {
  const haystack = [category ?? "", ...(tags ?? [])].join(" ").toLowerCase();
  if (!haystack.trim()) return "neutral";
  const sun = countCues(haystack, SUN_CUES);
  const storm = countCues(haystack, STORM_CUES);
  if (sun > storm) return "sun";
  if (storm > sun) return "storm";
  return "neutral";
}

/** Product shape the reorder needs (a subset of StoreProduct). */
export interface WeatherSortable {
  category?: string | null;
  tags?: readonly string[] | null;
}

/**
 * Stably reorder products so those matching the current weather condition lead,
 * preserving the incoming order within each group. A 'neutral' condition (mild
 * weather) returns the list unchanged — no merchandising churn when the weather
 * carries no signal.
 */
export function boostByWeather<T extends WeatherSortable>(
  products: readonly T[],
  condition: WeatherCondition,
): T[] {
  if (condition === "neutral") return [...products];
  const matches: T[] = [];
  const rest: T[] = [];
  for (const p of products) {
    if (productAffinity(p.category, p.tags) === condition) matches.push(p);
    else rest.push(p);
  }
  return [...matches, ...rest];
}
