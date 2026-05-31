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
    detect: { shops: 0, upserted: 0, resolved: 0 },
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

  // Phase 2: transform queued webhooks
  summary.transform = await transformPendingWebhooks();

  // Phase 3: run the detector for every ready shop
  const { data: ready } = await sb
    .from("shop_integrations")
    .select("shop_id")
    .eq("kind", "shopify")
    .eq("sync_status", "ready");
  for (const r of ready ?? []) {
    const res = await runReorderTimingDetector(String(r.shop_id));
    summary.detect.shops += 1;
    summary.detect.upserted += res.upserted;
    summary.detect.resolved += res.resolved;
  }

  return json(summary);
};
