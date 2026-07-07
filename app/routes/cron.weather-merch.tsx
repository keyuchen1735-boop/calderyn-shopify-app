import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { fetchRegionForecasts } from "~/lib/weather/open-meteo.server";
import { REGION_CENTROIDS } from "~/lib/weather/regions";
import { weatherCondition } from "~/lib/weather/affinity";

// Refresh the global region_weather table (4 rows) the public storefront reads to
// merchandise weather-relevant products. One batched Open-Meteo fetch, then an
// upsert — buyer requests never pay the external forecast call. Fail-closed: on a
// forecast error we leave the last-good rows in place.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  let forecasts;
  try {
    forecasts = await fetchRegionForecasts(REGION_CENTROIDS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron.weather-merch] forecast fetch failed", err);
    return json({ error: `forecast fetch failed: ${message}` }, { status: 502 });
  }
  const rows = [...forecasts].map(([region, f]) => ({
    region,
    condition: weatherCondition(f),
    avg_temp_c: f.avgTempC,
    precip_mm: f.precipMm,
    snow_cm: f.snowCm,
    avg_daylight_h: f.avgDaylightH,
    updated_at: new Date().toISOString(),
  }));
  const sb = getSupabase();
  const { error } = await sb.from("region_weather").upsert(rows, { onConflict: "region" });
  if (error) {
    console.error("[cron.weather-merch] upsert failed", error);
    return json({ error: error.message }, { status: 500 });
  }
  console.info("[cron.weather-merch] updated", rows.length, "regions");
  return json({ updated: rows.length, regions: rows.map((r) => ({ region: r.region, condition: r.condition })) });
};
