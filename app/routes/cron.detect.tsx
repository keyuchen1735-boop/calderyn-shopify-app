import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";

const MAX_DETECT_SHOPS = 10; // bounded per tick to stay under function timeout

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const summary = {
    detected: [] as string[], // shop_ids that ran successfully
    alertCount: 0,
    errors: [] as string[],
  };

  // Derive this deployment's origin so the engine function URL works across
  // preview, staging, and production without any hardcoded host.
  const origin = new URL(request.url).origin;

  // Query ready shops (bounded batch)
  const { data: ready } = await sb
    .from("shop_integrations")
    .select("shop_id")
    .eq("kind", "shopify")
    .eq("sync_status", "ready")
    .limit(MAX_DETECT_SHOPS);

  // For each ready shop, call the engine function. Per-shop isolation: one
  // failure must not abort detection for the remaining shops.
  for (const row of ready ?? []) {
    const shop_id = String(row.shop_id);
    try {
      const res = await fetch(`${origin}/api/engine/run`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.CRON_SECRET}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ shop_id }),
      });
      if (!res.ok) {
        throw new Error(`engine HTTP ${res.status} for shop ${shop_id}`);
      }
      const { alert_ids } = (await res.json()) as { shop_id: string; alert_ids: string[] };
      summary.detected.push(shop_id);
      summary.alertCount += alert_ids?.length ?? 0;
    } catch (err) {
      // One shop's detection failure must not deny other shops their alerts.
      summary.errors.push(shop_id);
      console.error(`[cron.detect] engine run failed for shop ${shop_id}`, err);
    }
  }

  return json(summary);
};
