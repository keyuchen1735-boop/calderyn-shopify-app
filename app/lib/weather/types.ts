/** One weather prediction as rendered in the Segments panel: pending awaits
 * the merchant's Arm, armed executes unattended once the forecast verifies. */
export interface WeatherSuggestionDTO {
  id: string;
  narrative: string;
  amountCents: number;
  status: "pending" | "armed";
  /** Last day the armed trigger may fire (forecast horizon). */
  expiresOn: string;
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
}

export interface WeatherForecastDTO {
  regions: RegionForecastDTO[];
  /** Merchant's home region when their location is known, else null. */
  homeRegion: string | null;
  hasLocation: boolean;
}
