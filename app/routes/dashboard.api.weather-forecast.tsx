import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";
import { fetchRegionForecasts } from "~/lib/weather/open-meteo.server";
import { forecastPoints, merchantLocationFrom } from "~/lib/weather/regions";
import { buildForecastView } from "~/lib/weather/forecast-view";
import type { WeatherForecastDTO } from "~/lib/weather/types";

// A 3-day forecast moves at most hourly; don't block every tab paint on an
// external HTTP round trip. Keyed by point set (merchant locations differ).
const TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; forecasts: Awaited<ReturnType<typeof fetchRegionForecasts>> }>();

async function cachedForecasts(points: ReturnType<typeof forecastPoints>) {
  const key = JSON.stringify(points);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.forecasts;
  const forecasts = await fetchRegionForecasts(points);
  cache.set(key, { at: Date.now(), forecasts });
  return forecasts;
}

// Live 3-day forecast per region for the Weather segments tab, with the
// merchant's home region queried at their exact location when known.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async (): Promise<WeatherForecastDTO> => {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("guardrail_config")
      .select("merchant_lat, merchant_lon")
      .eq("shop_id", session.shopId)
      .maybeSingle();
    // A failed config read must not silently demote a located merchant to
    // centroid forecasts (and re-show the location ask) — surface it.
    if (error) throw error;
    const merchant = merchantLocationFrom(data);

    const forecasts = await cachedForecasts(forecastPoints(merchant));
    const view = buildForecastView(forecasts, merchant);
    return {
      regions: view.regions,
      homeRegion: view.homeRegion,
      hasLocation: merchant !== null,
    };
  });
}
