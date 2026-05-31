import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { backfillShop } from "~/lib/ingest/backfill.server";
import { transformPendingWebhooks } from "~/lib/ingest/transform.server";
import { runReorderTimingDetector } from "~/lib/ingest/detectors/reorder-timing.server";

const MAX_BACKFILL_SHOPS = 5; // bounded per tick to stay under function timeout

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const summary = {
    backfilled: [] as string[],
    backfillErrors: [] as string[],
    transform: { processed: 0, facts: 0, dlq: 0 },
    transformError: null as string | null,
    detect: { shops: 0, upserted: 0, resolved: 0 },
    detectErrors: [] as string[],
  };

  // Phase 1: backfill pending shops (bounded)
  const { data: pending } = await sb
    .from("shop_integrations")
    .select("shop_id, shops!inner(shop_domain)")
    .eq("kind", "shopify")
    .eq("sync_status", "pending")
    .limit(MAX_BACKFILL_SHOPS);
  for (const row of pending ?? []) {
    const domain = (row as unknown as { shops: { shop_domain: string } }).shops.shop_domain;
    try {
      await backfillShop(domain);
      summary.backfilled.push(domain);
    } catch {
      summary.backfillErrors.push(domain); // detail already in ingestion_dlq
    }
  }

  // Phase 2: transform queued webhooks (isolated so a transform-query failure
  // can't abort Phase 3 for every ready shop).
  try {
    summary.transform = await transformPendingWebhooks();
  } catch (err) {
    summary.transformError = err instanceof Error ? err.message : String(err);
    console.error("[cron.ingest] transform phase failed", err);
  }

  // Phase 3: run the detector for every ready shop
  const { data: ready } = await sb
    .from("shop_integrations")
    .select("shop_id")
    .eq("kind", "shopify")
    .eq("sync_status", "ready");
  for (const r of ready ?? []) {
    const shopId = String(r.shop_id);
    try {
      const res = await runReorderTimingDetector(shopId);
      summary.detect.shops += 1;
      summary.detect.upserted += res.upserted;
      summary.detect.resolved += res.resolved;
    } catch (err) {
      // One shop's detector failure must not deny other shops their alerts.
      summary.detectErrors.push(shopId);
      console.error(`[cron.ingest] reorder_timing detector failed for shop ${shopId}`, err);
    }
  }

  return json(summary);
};
