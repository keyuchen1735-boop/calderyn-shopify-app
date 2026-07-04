import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { backfillShop, syncProductInventorySettings } from "~/lib/ingest/backfill.server";
import { transformPendingWebhooks } from "~/lib/ingest/transform.server";
import { reconcileAttributedRevenue } from "~/lib/attribution/revenue.server";
import { runShipCostResolution } from "~/lib/ship-cost/runner.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";

const MAX_BACKFILL_SHOPS = 5; // bounded per tick to stay under function timeout

// Stringify an unknown thrown value usefully. A raw Supabase/PostgREST error is a
// plain object `{ message, details, hint, code }` (NOT an Error), so `String(err)`
// yields "[object Object]". Prefer Error.message, then a Supabase error's
// message/details/code, then JSON.
function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; details?: unknown; code?: unknown };
    const parts = [e.message, e.details, e.code != null && `code=${e.code}`]
      .filter((p) => typeof p === "string" && p.length > 0);
    if (parts.length) return parts.join(" ");
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const summary = {
    backfilled: [] as string[],
    backfillErrors: [] as string[],
    inventorySettingsSynced: [] as string[],
    inventorySettingsErrors: [] as string[],
    transform: { processed: 0, facts: 0, dlq: 0 },
    transformError: null as string | null,
    attributionErrors: [] as string[],
    shipCostErrors: [] as string[],
  };

  // Phase 1: backfill pending shops (bounded). Surface a read failure as a 500
  // instead of swallowing it — a DB outage must not look like "no pending shops"
  // (an empty 200) to a cron monitor. Mirrors cron.autopilot's shop-list guard.
  const { data: pending, error: pendingErr } = await sb
    .from("shop_integrations")
    .select("shop_id, shops!inner(shop_domain)")
    .eq("kind", "shopify")
    .eq("sync_status", "pending")
    .limit(MAX_BACKFILL_SHOPS);
  if (pendingErr) {
    console.error("[cron.ingest] failed to list pending shops", pendingErr);
    return json({ error: `failed to list pending shops: ${pendingErr.message}` }, { status: 500 });
  }
  for (const row of pending ?? []) {
    const domain = (row as unknown as { shops: { shop_domain: string } }).shops.shop_domain;
    try {
      await backfillShop(domain);
      summary.backfilled.push(domain);
    } catch {
      summary.backfillErrors.push(domain); // detail already in ingestion_dlq
    }
  }

  // Existing shops predate the inventory-policy columns. Incrementally refresh
  // up to five catalogs per tick until every SKU has Shopify's safety settings.
  const { data: activeIntegrations, error: activeErr } = await sb
    .from("shop_integrations")
    .select("shop_id, shops!inner(shop_domain)")
    .eq("kind", "shopify")
    .in("sync_status", ["ready", "live"]);
  // This list feeds inventory sync, attribution reconcile (Phase 3) and
  // ship-cost resolution (Phase 4). A swallowed read failure would silently
  // zero all three and still return a healthy-looking 200 — fail visibly.
  if (activeErr) {
    console.error("[cron.ingest] failed to list active shops", activeErr);
    return json({ error: `failed to list active shops: ${activeErr.message}` }, { status: 500 });
  }
  for (const row of (activeIntegrations ?? []).slice(0, MAX_BACKFILL_SHOPS)) {
    const shopId = String(row.shop_id);
    const domain = (row as unknown as { shops?: { shop_domain?: string } }).shops?.shop_domain;
    if (!domain) continue;
    const { data: missing, error: missingErr } = await sb
      .from("sku_dim")
      .select("id")
      .eq("shop_id", shopId)
      .is("inventory_policy", null)
      .limit(1);
    if (missingErr) {
      summary.inventorySettingsErrors.push(`${domain}: ${missingErr.message}`);
      continue;
    }
    if (!missing?.length) continue;
    try {
      await syncProductInventorySettings(domain);
      summary.inventorySettingsSynced.push(domain);
    } catch (err) {
      summary.inventorySettingsErrors.push(`${domain}: ${stringifyError(err)}`);
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

  // Phase 3: reconcile attributed revenue for all active shops (per-shop isolation
  // — one shop's failure is recorded in summary.attributionErrors and does not
  // abort reconciliation for other shops).
  // Active Shopify shops. A backfilled shop's status is "ready" (backfill.server
  // sets it; nothing promotes a Shopify integration to "live"), so gating on
  // "live" alone matched zero real shops and silently skipped BOTH attribution
  // reconcile (Phase 3) and ship-cost resolution (Phase 4). Include "ready".
  const activeShops = (activeIntegrations ?? []).map((row) => ({ shop_id: row.shop_id }));
  for (const row of activeShops ?? []) {
    const shopId = (row as { shop_id: string }).shop_id;
    try {
      await reconcileAttributedRevenue(shopId, sb);
    } catch (err) {
      summary.attributionErrors.push(`${shopId}: ${stringifyError(err)}`);
      console.error("[cron.ingest] attribution reconcile failed for shop", shopId, err);
    }
  }

  // Phase 4: resolve ship-cost and roll into sku_pnl for all active shops (same
  // per-shop isolation as Phase 3 — one shop's failure does not abort others).
  for (const row of activeShops ?? []) {
    const shopId = (row as { shop_id: string }).shop_id;
    try {
      await runShipCostResolution(sb, shopId, {
        shopCountry: null, // TODO: source shop origin country (Plan 2)
      });
    } catch (err) {
      summary.shipCostErrors.push(`${shopId}: ${stringifyError(err)}`);
      console.error("[cron.ingest] ship-cost resolution failed for shop", shopId, err);
    }
  }

  return json(summary);
};
