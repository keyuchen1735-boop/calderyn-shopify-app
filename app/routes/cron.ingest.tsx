import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { backfillShop } from "~/lib/ingest/backfill.server";
import { transformPendingWebhooks } from "~/lib/ingest/transform.server";
import { reconcileAttributedRevenue } from "~/lib/attribution/revenue.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";

const MAX_BACKFILL_SHOPS = 5; // bounded per tick to stay under function timeout

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const summary = {
    backfilled: [] as string[],
    backfillErrors: [] as string[],
    transform: { processed: 0, facts: 0, dlq: 0 },
    transformError: null as string | null,
    attributionErrors: [] as string[],
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
  // doesn't abort the response).
  try {
    summary.transform = await transformPendingWebhooks();
  } catch (err) {
    summary.transformError = err instanceof Error ? err.message : String(err);
    console.error("[cron.ingest] transform phase failed", err);
  }

  // Phase 3: reconcile attributed revenue for all live shops (per-shop isolation
  // — one shop's failure is recorded in summary.attributionErrors and does not
  // abort reconciliation for other shops).
  const { data: liveShops } = await sb
    .from("shop_integrations")
    .select("shop_id")
    .eq("kind", "shopify")
    .eq("sync_status", "live");
  for (const row of liveShops ?? []) {
    const shopId = (row as { shop_id: string }).shop_id;
    try {
      await reconcileAttributedRevenue(shopId, sb);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.attributionErrors.push(`${shopId}: ${msg}`);
      console.error("[cron.ingest] attribution reconcile failed for shop", shopId, err);
    }
  }

  return json(summary);
};
