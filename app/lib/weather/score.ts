// Pure weather → demand-favorability score in [0,1]. Higher = worse weather =
// (hypothesised) more indoor mobile browsing and e-commerce traffic. Weights sum
// to 1 and every factor is clamped to [0,1], so the output is inherently in
// [0,1] with no cross-region normalization needed.

/** One forecast day, for day-by-day display; scoring stays window-level. */
export interface DayForecast {
  date: string;
  avgTempC: number;
  precipMm: number;
  snowCm: number;
}

export interface RegionForecast {
  /** Mean daily temperature over the forecast horizon, °C. */
  avgTempC: number;
  /** Total precipitation over the horizon, mm. */
  precipMm: number;
  /** Total snowfall over the horizon, cm. */
  snowCm: number;
  /** Mean daylight hours per day over the horizon. */
  avgDaylightH: number;
  /** Per-day breakdown when the provider dates the series. */
  days?: DayForecast[];
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function favorability(f: RegionForecast): number {
  const coldness = clamp01((18 - f.avgTempC) / 30);
  const wetness = clamp01(f.precipMm / 30);
  const snowiness = clamp01(f.snowCm / 10);
  const darkness = clamp01((12 - f.avgDaylightH) / 6);
  return 0.4 * coldness + 0.3 * wetness + 0.2 * snowiness + 0.1 * darkness;
}
