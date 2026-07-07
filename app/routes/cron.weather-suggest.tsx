import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { mapWithConcurrency } from "~/lib/ads/concurrency";
import {
  runWeatherExecuteForShop,
  runWeatherSuggestForShop,
} from "~/lib/actions/weather-suggest.server";
import { fetchRegionForecasts } from "~/lib/weather/open-meteo.server";

const CONCURRENCY = 4;

/** Memoize Open-Meteo calls for the duration of one cron run: the sweep and
 * the suggest step (and every unlocated shop) query identical point sets, so
 * key the promise on the serialized points. */
function makeForecastMemo(): typeof fetchRegionForecasts {
  const cache = new Map<string, ReturnType<typeof fetchRegionForecasts>>();
  return (points) => {
    const key = JSON.stringify(points);
    let hit = cache.get(key);
    if (!hit) {
      hit = fetchRegionForecasts(points);
      cache.set(key, hit);
    }
    return hit;
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const sb = getSupabase();
  const summary = {
    shops: 0,
    suggested: 0,
    skipped: 0,
    // Why shops were skipped, keyed by RunResult.skippedReason. A wall of
    // "no_eligible_campaigns" looks very different from calm-weather
    // "no_suggestion" days — the flat skipped count alone can't tell an outage
    // from a sunny week.
    skippedReasons: {} as Record<string, number>,
    failed: 0,
    executed: 0,
    expired: 0,
    held: 0,
    executeFailed: 0,
    errors: [] as string[],
  };

  // Sweep population = dial-on shops ∪ shops holding armed/stale rows. The
  // union matters: a merchant who arms a move and then turns the dial to 0
  // must still be swept so the armed row is disarmed, not stranded.
  const [dialOn, outstanding] = await Promise.all([
    sb.from("guardrail_config").select("shop_id").gt("weather_sensitivity", 0),
    sb.from("weather_suggestion").select("shop_id").in("status", ["armed", "pending"]),
  ]);
  const listErr = dialOn.error ?? outstanding.error;
  if (listErr) {
    console.error("[cron.weather-suggest] failed to list shops", listErr);
    return json({ error: `failed to list shops: ${listErr.message}` }, { status: 500 });
  }
  const shopIds = [
    ...new Set([...(dialOn.data ?? []), ...(outstanding.data ?? [])].map((r) => String(r.shop_id))),
  ];

  const fetchForecasts = makeForecastMemo();

  // Per shop: first sweep outstanding predictions against today's fresh
  // forecast (execute / expire / hold), THEN write today's new prediction.
  // The two phases fail independently — a flaky execute sweep must not starve
  // suggestion generation for the day (and vice versa).
  const settled = await mapWithConcurrency(shopIds, CONCURRENCY, async (shopId) => {
    const [exec, suggest] = await Promise.allSettled([
      runWeatherExecuteForShop(shopId, sb, { fetchForecasts }),
      runWeatherSuggestForShop(shopId, sb, { fetchForecasts }),
    ]);
    return { exec, suggest };
  });
  settled.forEach((r, i) => {
    if (!r.ok) {
      // Only a throw outside both phases lands here (both are allSettled).
      summary.failed += 1;
      const message = r.error instanceof Error ? r.error.message : String(r.error);
      summary.errors.push(`${shopIds[i]}: ${message}`);
      console.error(`[cron.weather-suggest] failed for ${shopIds[i]}`, r.error);
      return;
    }
    summary.shops += 1;
    const { exec, suggest } = r.value;
    if (suggest.status === "fulfilled") {
      summary.suggested += suggest.value.suggested;
      if (suggest.value.suggested === 0) {
        summary.skipped += 1;
        const reason = suggest.value.skippedReason ?? "unknown";
        summary.skippedReasons[reason] = (summary.skippedReasons[reason] ?? 0) + 1;
      }
    } else {
      summary.failed += 1;
      summary.errors.push(`${shopIds[i]} suggest: ${String(suggest.reason)}`);
      console.error(`[cron.weather-suggest] suggest failed for ${shopIds[i]}`, suggest.reason);
    }
    if (exec.status === "fulfilled") {
      summary.executed += exec.value.executed;
      summary.expired += exec.value.expired;
      summary.held += exec.value.held;
      summary.executeFailed += exec.value.failed;
    } else {
      summary.failed += 1;
      summary.errors.push(`${shopIds[i]} execute: ${String(exec.reason)}`);
      console.error(`[cron.weather-suggest] execute failed for ${shopIds[i]}`, exec.reason);
    }
  });
  console.info("[cron.weather-suggest] summary", summary);
  return json(summary);
};
