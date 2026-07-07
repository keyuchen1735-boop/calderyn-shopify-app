// Fetch a 3-day daily forecast for each region centroid from Open-Meteo in one
// batched request (comma-separated lat/lon → array response), and aggregate each
// location's daily arrays into the RegionForecast shape the score consumes.
// Plain fetch, no SDK, no API key. On any failure the caller SKIPS the shop
// rather than acting on a fabricated forecast.
import type { RegionCode } from "../ads/actions";
import type { RegionForecast } from "./score";

interface Point {
  region: RegionCode;
  lat: number;
  lon: number;
}

interface OpenMeteoLocation {
  daily?: {
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_sum?: number[];
    snowfall_sum?: number[];
    daylight_duration?: number[];
  };
}

/**
 * How many days each forecast (and therefore each suggestion) covers. The
 * suggestion narrative and the panel's visibility window both derive from
 * this — bumping it here keeps all three in step.
 */
export const FORECAST_HORIZON_DAYS = 3;

const DAILY = "temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum,daylight_duration";
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/**
 * A 200 response can still omit (or rename) the daily arrays the score consumes.
 * Aggregating that would fabricate a 0 °C / 0-daylight forecast — which scores as
 * spuriously HIGH demand and could misdirect a real budget move — so a location
 * missing the temperature/daylight series is treated as "no forecast" and skipped
 * by the caller, honouring the file's never-fabricate contract. Precipitation and
 * snowfall may legitimately be absent (dry days), so they are not required here.
 */
function hasForecast(loc: OpenMeteoLocation): boolean {
  const d = loc.daily;
  return (
    !!d &&
    Array.isArray(d.temperature_2m_max) &&
    d.temperature_2m_max.length > 0 &&
    Array.isArray(d.temperature_2m_min) &&
    d.temperature_2m_min.length > 0 &&
    Array.isArray(d.daylight_duration) &&
    d.daylight_duration.length > 0
  );
}

function aggregate(loc: OpenMeteoLocation): RegionForecast {
  const d = loc.daily ?? {};
  const tmax = d.temperature_2m_max ?? [];
  const tmin = d.temperature_2m_min ?? [];
  const dayMeans = tmax.map((mx, i) => (mx + (tmin[i] ?? mx)) / 2);
  return {
    avgTempC: mean(dayMeans),
    precipMm: sum(d.precipitation_sum ?? []),
    snowCm: sum(d.snowfall_sum ?? []),
    avgDaylightH: mean((d.daylight_duration ?? []).map((s) => s / 3600)),
  };
}

export async function fetchRegionForecasts(
  points: readonly Point[],
  opts: { timeoutMs?: number } = {},
): Promise<Map<RegionCode, RegionForecast>> {
  const lat = points.map((p) => p.lat).join(",");
  const lon = points.map((p) => p.lon).join(",");
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=${DAILY}&forecast_days=${FORECAST_HORIZON_DAYS}&timezone=UTC`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);

  const json = (await res.json()) as OpenMeteoLocation | OpenMeteoLocation[];
  const locations = Array.isArray(json) ? json : [json];
  const out = new Map<RegionCode, RegionForecast>();
  points.forEach((p, i) => {
    const loc = locations[i];
    if (loc && hasForecast(loc)) out.set(p.region, aggregate(loc));
  });
  return out;
}
