import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";

const MAX_DETECT_SHOPS = 10; // bounded per tick to stay under function timeout

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const summary = {
    detected: [] as string[], // shop_ids that ran successfully
    alertCount: 0,
    errors: [] as string[],
  };

  // Call the engines through the public app origin: Vercel cron invokes this
  // route on the *.vercel.app deployment URL, which deployment protection
  // walls off from the self-fetch below (the engine 401s before auth runs).
  // Fall back to the request origin where SHOPIFY_APP_URL is unset (local dev).
  const origin = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;

  // Detection spans two engines, both POST { shop_id } → { shop_id, alert_ids }:
  //   /api/engine/run     — Python pipeline (margin erosion, campaign grading,
  //                         Claude ranking, … via the DETECTOR_REGISTRY).
  //   /api/detectors/run  — TS detector registry (free-shipping leakage).
  // They live at DISTINCT paths on purpose: a Remix route and the Python
  // serverless function must never share a URL, or they collide at the same
  // Vercel build-output function and take the whole deploy down (2026-06-16).
  const enginePaths = ["/api/engine/run", "/api/detectors/run"];

  // Query ready shops (bounded batch)
  const { data: ready } = await sb
    .from("shop_integrations")
    .select("shop_id")
    .eq("kind", "shopify")
    .eq("sync_status", "ready")
    .limit(MAX_DETECT_SHOPS);

  // For each ready shop, drive both engines. Per-shop isolation: one shop's
  // failure must not abort detection for the remaining shops.
  for (const row of ready ?? []) {
    const shop_id = String(row.shop_id);
    try {
      let alerts = 0;
      for (const path of enginePaths) {
        const res = await fetch(`${origin}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${process.env.CRON_SECRET}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ shop_id }),
        });
        if (!res.ok) {
          throw new Error(`engine HTTP ${res.status} for shop ${shop_id} (${path})`);
        }
        const { alert_ids } = (await res.json()) as { shop_id: string; alert_ids: string[] };
        alerts += alert_ids?.length ?? 0;
      }
      summary.detected.push(shop_id);
      summary.alertCount += alerts;
    } catch (err) {
      // One shop's detection failure must not deny other shops their alerts.
      summary.errors.push(shop_id);
      console.error(`[cron.detect] engine run failed for shop ${shop_id}`, err);
    }
  }

  return json(summary);
};
