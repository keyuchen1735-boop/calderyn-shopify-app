// Resolve the CURRENT SHOPPER's weather condition for storefront merchandising.
// The visitor's region comes from the request's Vercel edge geo headers (set on
// every request), so each shopper sees products for THEIR own local weather with
// no merchant setup and no shop-fixed region. Gated by the shop's own
// weather_merchandising toggle. Fully fail-safe: a missing header, a non-US
// visitor, a missing region_weather row, an opted-out shop, or any error all
// resolve to "neutral" (no boost). Never throws — this is a public buyer path.
import { getSupabase } from "~/lib/supabase.server";
import { getSeoSettings } from "~/lib/seo/seo-store.server";
import { nearestRegion } from "~/lib/weather/regions";
import { WEATHER_CONDITIONS, type WeatherCondition } from "~/lib/weather/affinity";
import type { RegionCode } from "~/lib/ads/actions";

/** The visitor's coarse RegionCode from the request's edge geo headers, or null
 *  for a non-US visitor or missing/unparseable coordinates. */
export function visitorRegion(request: Request): RegionCode | null {
  if (request.headers.get("x-vercel-ip-country") !== "US") return null;
  const latH = request.headers.get("x-vercel-ip-latitude");
  const lonH = request.headers.get("x-vercel-ip-longitude");
  // A missing header is null; Number(null) is 0 (finite), so guard presence first
  // to avoid geolocating an absent coordinate to 0,0.
  if (!latH || !lonH) return null;
  const lat = Number(latH);
  const lon = Number(lonH);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return nearestRegion(lat, lon);
}

/** The weather condition to merchandise for THIS shopper: gated by the shop's
 *  toggle, keyed on the visitor's own region. "neutral" (no boost) on any
 *  opt-out, missing signal, or error. */
export async function storefrontWeatherCondition(
  request: Request,
  shopId: string,
): Promise<WeatherCondition> {
  try {
    const settings = await getSeoSettings(shopId);
    if (!settings.weatherMerchandising) return "neutral";
    const region = visitorRegion(request);
    if (!region) return "neutral";
    const { data } = await getSupabase()
      .from("region_weather")
      .select("condition")
      .eq("region", region)
      .maybeSingle();
    const stored = (data as { condition?: string } | null)?.condition;
    return stored && (WEATHER_CONDITIONS as readonly string[]).includes(stored)
      ? (stored as WeatherCondition)
      : "neutral";
  } catch (err) {
    console.error("[storefront] storefrontWeatherCondition failed, defaulting to neutral", err);
    return "neutral";
  }
}
