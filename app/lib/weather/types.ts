/** One weather prediction as rendered in the Segments panel: pending awaits
 * the merchant's Arm, armed executes unattended once the forecast verifies. */
export interface WeatherSuggestionDTO {
  id: string;
  narrative: string;
  amountCents: number;
  status: "pending" | "armed" | "applied";
  /** Last day the armed trigger may fire (forecast horizon). */
  expiresOn: string;
  /** Region whose budget is cut / raised — drives the icon-led flow row. */
  sourceRegion: string;
  destRegion: string;
  /** When an applied move executed (ISO timestamp). */
  executedAt?: string;
}

/** Per-region forecast card for the Weather segments tab. */
export interface RegionForecastDTO {
  region: string;
  avgTempC: number;
  precipMm: number;
  snowCm: number;
  avgDaylightH: number;
  /** Demand favorability in [0,1] — higher = weather favors more budget. */
  score: number;
  /** Per-day breakdown for the day chips; absent when the provider omits dates. */
  days?: Array<{ date: string; avgTempC: number; precipMm: number; snowCm: number }>;
}

export interface WeatherForecastDTO {
  regions: RegionForecastDTO[];
  /** Merchant's home region when their location is known, else null. */
  homeRegion: string | null;
  hasLocation: boolean;
}

/** Sensitivity dial at/above this: predictions arm and execute unattended. */
export const WEATHER_AUTO_THRESHOLD = 100;
export const isWeatherAuto = (sensitivity: number): boolean =>
  sensitivity >= WEATHER_AUTO_THRESHOLD;

/** The two merchant-facing modes the dial collapses to: manual (approve,
 *  reject or schedule each move) and auto (moves run unattended). There is
 *  no "off" mode — the guardrails dial at 0 still reads as manual. */
export type WeatherMode = "manual" | "auto";

export function weatherMode(sensitivity: number): WeatherMode {
  return isWeatherAuto(sensitivity) ? "auto" : "manual";
}

/** Dial value for a chosen mode; manual keeps a mid-range dial the merchant
 *  already set rather than clobbering it. */
export function sensitivityForMode(mode: WeatherMode, current: number): number {
  if (mode === "auto") return WEATHER_AUTO_THRESHOLD;
  return current > 0 && current < WEATHER_AUTO_THRESHOLD ? current : 50;
}
