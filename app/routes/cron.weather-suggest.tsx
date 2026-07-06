import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { mapWithConcurrency } from "~/lib/ads/concurrency";
import { runWeatherSuggestForShop } from "~/lib/actions/weather-suggest.server";

const CONCURRENCY = 4;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const sb = getSupabase();
  const summary = { shops: 0, suggested: 0, skipped: 0, failed: 0, errors: [] as string[] };

  const { data: rows, error: listErr } = await sb
    .from("guardrail_config")
    .select("shop_id")
    .gt("weather_sensitivity", 0);
  if (listErr) {
    console.error("[cron.weather-suggest] failed to list shops", listErr);
    return json({ error: `failed to list shops: ${listErr.message}` }, { status: 500 });
  }
  const shopIds = (rows ?? []).map((r) => String(r.shop_id));

  const settled = await mapWithConcurrency(shopIds, CONCURRENCY, (shopId) =>
    runWeatherSuggestForShop(shopId, sb),
  );
  settled.forEach((r, i) => {
    if (r.ok) {
      summary.shops += 1;
      summary.suggested += r.value.suggested;
      if (r.value.suggested === 0) summary.skipped += 1;
    } else {
      summary.failed += 1;
      const message = r.error instanceof Error ? r.error.message : String(r.error);
      summary.errors.push(`${shopIds[i]}: ${message}`);
      console.error(`[cron.weather-suggest] failed for ${shopIds[i]}`, r.error);
    }
  });
  console.info("[cron.weather-suggest] summary", summary);
  return json(summary);
};
