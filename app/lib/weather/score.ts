// Pure weather → online-demand model. Grounded in Steinker, Pesch & Thonemann
// (2017), "The Value of Weather Information for E-Commerce Operations" (Production
// and Operations Management): the effect of weather on online demand is
// ASYMMETRIC — good weather has a STRONG negative effect (people go outside and
// stop browsing), while bad weather's positive effect is much WEAKER. So we model
// a "niceness" of the weather and apply a large suppression on the good side and a
// small boost on the bad side, rather than a symmetric linear score.
//
// favorability() stays a single number in [0,1] (0.5 = neutral, higher = more
// predicted online demand) so the ranking/sizing consumers are unchanged.
// demandConfidence() exposes how reliable that signal is: the good-weather
// suppression is the trustworthy half, so confidence is highest for clearly nice
// weather and lower (but nonzero) for clearly bad weather; mild weather carries
// almost no signal (weather is a secondary, occasional demand driver).

export interface RegionForecast {
  /** Mean daily temperature over the forecast horizon, °C. */
  avgTempC: number;
  /** Total precipitation over the horizon, mm. */
  precipMm: number;
  /** Total snowfall over the horizon, cm. */
  snowCm: number;
  /** Mean daylight hours per day over the horizon. */
  avgDaylightH: number;
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x: number): number => clamp(x, 0, 1);

/**
 * How "nice" the weather is for being outside / away from screens, in [-1, 1].
 * +1 = ideal outdoor weather (warm, dry, bright, no snow) that pulls shoppers off
 * their devices; -1 = miserable (cold, wet, dark, snowy) that keeps them indoors.
 * Weights mirror the original factor emphasis (temperature dominant, then
 * precipitation, then daylight); snow is a one-sided penalty (its absence is not a
 * bonus). Every component is individually clamped, so the weighted sum stays in
 * [-1, 1] without renormalization.
 */
export function niceness(f: RegionForecast): number {
  const gTemp = clamp((f.avgTempC - 12) / 13, -1, 1); // warmer = nicer (0 at 12°C, +1 at 25°C)
  const gDry = clamp(1 - f.precipMm / 15, -1, 1); //         drier = nicer (0 at 15mm, -1 at 30mm)
  const gSun = clamp((f.avgDaylightH - 11) / 3, -1, 1); //   brighter = nicer (0 at 11h, +1 at 14h)
  const gSnow = -clamp(f.snowCm / 10, 0, 1); //             snow only subtracts (0 clear, -1 at 10cm)
  return clamp(0.45 * gTemp + 0.3 * gDry + 0.15 * gSun + 0.1 * gSnow, -1, 1);
}

// Asymmetry constants: good weather suppresses demand hard; bad weather lifts it
// only a little. SUPPRESSION > BOOST is the whole point (the 2017 finding).
export const SUPPRESSION = 0.5;
export const BOOST = 0.2;

/**
 * Predicted online-demand favorability in [0,1]. 0.5 = neutral weather. Nice
 * weather drives it down steeply (toward 0); bad weather lifts it gently (toward
 * ~0.7). Higher = more predicted demand, so ranking regions by this still puts
 * good-weather regions at the bottom (cut budget/stock) and bad-weather regions at
 * the top (favor them) — but with a magnitude that respects the asymmetry.
 */
export function favorability(f: RegionForecast): number {
  const g = niceness(f);
  return clamp01(0.5 - SUPPRESSION * Math.max(0, g) + BOOST * Math.max(0, -g));
}

/**
 * Confidence in [0,1] that the demand signal above is real and actionable. The
 * good-weather suppression is the reliable half of the asymmetry, so a clearly
 * nice forecast earns full confidence; a clearly bad one earns partial confidence
 * (the boost is real but weak); mild weather earns almost none. Consumers gate on
 * this so the feature only acts when the weather genuinely moves the needle.
 */
export function demandConfidence(f: RegionForecast): number {
  const g = niceness(f);
  return clamp01(1.0 * Math.max(0, g) + 0.5 * Math.max(0, -g));
}
