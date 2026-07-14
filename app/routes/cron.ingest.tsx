import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import {
  backfillShop,
  syncProductInventorySettings,
} from "~/lib/ingest/backfill.server";
import { repairOrderDestinationsForIntegration } from "~/lib/ingest/destination-repair.server";
import { transformPendingWebhooks } from "~/lib/ingest/transform.server";
import { transformPendingOwnedEvents } from "~/lib/ingest/owned/transform.server";
import { reconcileAttributedRevenue } from "~/lib/attribution/revenue.server";
import { runShipCostResolution } from "~/lib/ship-cost/runner.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";

const MAX_BACKFILL_SHOPS = 5; // bounded per tick to stay under function timeout
const MAX_DESTINATION_REPAIR_SHOPS = 5;

// Stringify an unknown thrown value usefully. A raw Supabase/PostgREST error is a
// plain object `{ message, details, hint, code }` (NOT an Error), so `String(err)`
// yields "[object Object]". Prefer Error.message, then a Supabase error's
// message/details/code, then JSON.
function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; details?: unknown; code?: unknown };
    const parts = [
      e.message,
      e.details,
      e.code != null && `code=${e.code}`,
    ].filter((p) => typeof p === "string" && p.length > 0);
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
  if (
    !isAuthorizedCron(
      request.headers.get("authorization"),
      process.env.CRON_SECRET,
    )
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const summary = {
    backfilled: [] as string[],
    backfillErrors: [] as string[],
    inventorySettingsSynced: [] as string[],
    inventorySettingsErrors: [] as string[],
    destinationRepair: { shops: 0, scanned: 0, updated: 0, checked: 0 },
    destinationRepairErrors: [] as string[],
    transform: { processed: 0, facts: 0, dlq: 0 },
    transformError: null as string | null,
    ownedTransform: { processed: 0, facts: 0, dlq: 0 },
    ownedTransformError: null as string | null,
    attributionErrors: [] as string[],
    shipCostErrors: [] as string[],
    // A failed driver query (the shop lists Phases 1-4 iterate) yields null and
    // would otherwise silently skip whole phases for every shop with no trace.
    driverErrors: [] as string[],
    phaseMs: {} as Record<string, number>,
  };

  // This tick has been observed exhausting the 300s function ceiling (504), which
  // silently starves whatever phases come after the slow one. Log each phase's
  // elapsed time AS IT COMPLETES, so when a tick times out the log trail still
  // names the phase that ate the budget (the one after the last logged mark).
  let phaseStartedAt = Date.now();
  const mark = (name: string) => {
    const ms = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    summary.phaseMs[name] = ms;
    console.log(`[cron.ingest] phase ${name} finished in ${ms}ms`);
  };

  // Phase 1: backfill pending shops (bounded)
  const { data: pending, error: pendingErr } = await sb
    .from("shop_integrations")
    .select("shop_id, shops!inner(shop_domain)")
    .eq("kind", "shopify")
    .eq("sync_status", "pending")
    .limit(MAX_BACKFILL_SHOPS);
  if (pendingErr) {
    summary.driverErrors.push(`pending: ${stringifyError(pendingErr)}`);
    console.error("[cron.ingest] pending-shops query failed", pendingErr);
  }
  for (const row of pending ?? []) {
    const domain = (row as unknown as { shops: { shop_domain: string } }).shops
      .shop_domain;
    try {
      await backfillShop(domain);
      summary.backfilled.push(domain);
    } catch {
      summary.backfillErrors.push(domain); // detail already in ingestion_dlq
    }
  }
  mark("backfill");

  // Existing shops predate the inventory-policy columns. Incrementally refresh
  // up to five catalogs per tick until every SKU has Shopify's safety settings.
  const { data: activeIntegrations, error: activeErr } = await sb
    .from("shop_integrations")
    .select("shop_id, shops!inner(shop_domain)")
    .eq("kind", "shopify")
    .in("sync_status", ["ready", "live"]);
  if (activeErr) {
    // This list drives inventory-settings sync AND attribution reconcile AND
    // ship-cost resolution below — a swallowed failure starves all three.
    summary.driverErrors.push(`active_integrations: ${stringifyError(activeErr)}`);
    console.error("[cron.ingest] active-integrations query failed", activeErr);
  }
  for (const row of (activeIntegrations ?? []).slice(0, MAX_BACKFILL_SHOPS)) {
    const shopId = String(row.shop_id);
    const domain = (row as unknown as { shops?: { shop_domain?: string } })
      .shops?.shop_domain;
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
  mark("inventory_settings");

  // Claim and stamp a bounded batch atomically before any Shopify API work.
  // Fresh claims are leased, so overlapping cron/manual invocations drain
  // different tenants and an interrupted worker cannot monopolize the queue.
  const { data: repairIntegrations, error: repairSelectError } = await sb.rpc(
    "claim_order_destination_repairs",
    { p_limit: MAX_DESTINATION_REPAIR_SHOPS },
  );
  if (repairSelectError) {
    summary.destinationRepairErrors.push(
      `selection: ${stringifyError(repairSelectError)}`,
    );
  } else {
    for (const row of repairIntegrations ?? []) {
      const shopId = String(row.shop_id);
      const claim = row as unknown as {
        shop_id: string;
        shop_domain: string;
        claimed_at: string;
      };
      const domain = claim.shop_domain;
      if (!domain || !claim.claimed_at) continue;
      try {
        const repaired = await repairOrderDestinationsForIntegration(
          { shopId, shopDomain: domain, claimedAt: claim.claimed_at },
          sb,
        );
        summary.destinationRepair.shops += 1;
        summary.destinationRepair.scanned += repaired.scanned;
        summary.destinationRepair.updated += repaired.updated;
        summary.destinationRepair.checked += repaired.checked;
      } catch (err) {
        summary.destinationRepairErrors.push(
          `${domain}: ${stringifyError(err)}`,
        );
        console.error(
          "[cron.ingest] destination repair failed for shop",
          shopId,
          err,
        );
      }
    }
  }
  mark("destination_repair");

  // Phase 2: transform queued webhooks (isolated so a transform-query failure
  // doesn't abort the response).
  try {
    summary.transform = await transformPendingWebhooks();
  } catch (err) {
    summary.transformError = err instanceof Error ? err.message : String(err);
    console.error("[cron.ingest] transform phase failed", err);
  }
  mark("transform");

  // Phase 2b: transform queued OWNED checkout events (isolated like Phase 2, so an
  // owned-transform failure doesn't abort the Shopify transform or the response).
  try {
    summary.ownedTransform = await transformPendingOwnedEvents();
  } catch (err) {
    summary.ownedTransformError =
      err instanceof Error ? err.message : String(err);
    console.error("[cron.ingest] owned transform phase failed", err);
  }
  mark("owned_transform");

  // Phase 3: reconcile attributed revenue for all active shops (per-shop isolation
  // — one shop's failure is recorded in summary.attributionErrors and does not
  // abort reconciliation for other shops).
  // Active Shopify shops. A backfilled shop's status is "ready" (backfill.server
  // sets it; nothing promotes a Shopify integration to "live"), so gating on
  // "live" alone matched zero real shops and silently skipped BOTH attribution
  // reconcile (Phase 3) and ship-cost resolution (Phase 4). Include "ready".
  const activeShops = (activeIntegrations ?? []).map((row) => ({
    shop_id: row.shop_id,
  }));
  for (const row of activeShops ?? []) {
    const shopId = (row as { shop_id: string }).shop_id;
    try {
      await reconcileAttributedRevenue(shopId, sb);
    } catch (err) {
      summary.attributionErrors.push(`${shopId}: ${stringifyError(err)}`);
      console.error(
        "[cron.ingest] attribution reconcile failed for shop",
        shopId,
        err,
      );
    }
  }
  mark("attribution");

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
      console.error(
        "[cron.ingest] ship-cost resolution failed for shop",
        shopId,
        err,
      );
    }
  }
  mark("ship_cost");

  // Import-from-Shopify runs are drained by /cron/import (their own cron), not here:
  // a pending import is a merchant waiting on a progress screen, and this tick can
  // exhaust its function budget on the phases above.

  return json(summary);
};
