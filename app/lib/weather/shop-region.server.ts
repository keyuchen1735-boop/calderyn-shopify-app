// app/lib/weather/shop-region.server.ts
// Shared resolver for a shop's current storefront weather condition, used by
// both the storefront boost gate (catalog.owned.server.ts) and the dashboard
// Preferences status line. Fully fail-safe: any missing location/region row,
// invalid condition, or query error returns null rather than throwing, so a
// broken weather signal never blocks a render on either surface.
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";
import { WEATHER_CONDITIONS, type WeatherCondition } from "./affinity";

/** Resolve a shop's current storefront weather condition from its active location
 *  region + the cron-refreshed region_weather table. Fail-safe: any missing
 *  location/region row or error → null (callers degrade to no boost / no status). */
export async function shopRegionCondition(
  shopId: string,
): Promise<{ region: string; condition: WeatherCondition } | null> {
  if (!isUuid(shopId)) return null;
  try {
    const sb = getSupabase();
    const { data: loc } = await sb
      .from("location_dim")
      .select("region")
      .eq("shop_id", shopId)
      .eq("active", true)
      .not("region", "is", null)
      .limit(1)
      .maybeSingle();
    const region = (loc as { region?: string } | null)?.region;
    if (!region) return null;
    const { data: w } = await sb.from("region_weather").select("condition").eq("region", region).maybeSingle();
    const condition = (w as { condition?: string } | null)?.condition;
    if (!condition || !WEATHER_CONDITIONS.includes(condition as WeatherCondition)) return null;
    return { region, condition: condition as WeatherCondition };
  } catch (err) {
    console.error("[weather] shopRegionCondition failed", err);
    return null;
  }
}
