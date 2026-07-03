// app/lib/install.server.ts
//
// The one install routine both entry points share: the embedded afterAuth hook
// (app/shopify.server.ts) and the dashboard OAuth callback, where approve IS
// the install. Keeping it single-sourced is what guarantees a dashboard-first
// shop gets the same tenant provisioning, CarrierService registration, and
// ingest enqueue an App Store install gets — and that a re-connecting shop is
// reactivated (provisionShop clears uninstalled_at) before the GDPR sweep can
// touch it.
import { getSupabase, provisionShop, resolveShopId } from "./supabase.server";
import { enqueueShopifyBackfill, shopifyNeverSynced } from "./ingest/enqueue.server";
import { registerCarrierService } from "./shipping/carrier-service.server";
import { resurfaceAllSnoozes } from "./actions/snooze.server";
import type { AdminGraphqlClient } from "./shopify/inventory.server";

export async function completeShopInstall(opts: {
  shop: string;
  admin: AdminGraphqlClient;
  /**
   * The embedded install pulls catalog + last 30 days of orders inline so the
   * merchant sees data immediately instead of waiting for the /cron/ingest
   * tick. The dashboard connect passes false — its 12-month import run covers
   * the same ground.
   */
  inlineBackfill: boolean;
}): Promise<void> {
  const { shop, admin } = opts;
  await provisionShop(shop);
  // Register the Shopify CarrierService so a buyer's checkout computes shipping
  // via Calderyn (#6.4). Idempotent (re-auth never duplicates). Best-effort and
  // isolated: it requires the write_shipping scope + a qualifying store plan, so
  // a userError/throw here (e.g. before re-consent) must never block install.
  try {
    const carrierShopId = await resolveShopId(shop);
    await registerCarrierService(admin, {
      shopId: carrierShopId,
      baseUrl: process.env.SHOPIFY_APP_URL || "https://app.calderyncompany.com",
    });
  } catch (err) {
    console.error(`[install] CarrierService registration failed for ${shop}`, err);
  }
  // Snapshot first-install state BEFORE enqueue resets sync_status.
  const firstInstall = opts.inlineBackfill && (await shopifyNeverSynced(shop));
  await enqueueShopifyBackfill(shop);
  if (firstInstall) {
    try {
      // Dynamic import avoids a static import cycle
      // (backfill -> shopify-admin -> shopify.server -> this module).
      const { backfillShop } = await import("./ingest/backfill.server");
      await backfillShop(shop);
    } catch (err) {
      // Best-effort: backfillShop marks sync_status='error' on failure, which
      // the cron skips. Reset to 'pending' so /cron/ingest still recovers the
      // data, then swallow — a backfill failure must not block install.
      console.error(`[install] inline backfill failed for ${shop}`, err);
      await enqueueShopifyBackfill(shop);
    }
  }
  // A fresh login re-surfaces alerts snoozed in a prior session (snooze
  // hides until +1 day or next login, whichever first). Kept last so it
  // can never disrupt provisioning/backfill.
  await resurfaceAllSnoozes(getSupabase(), await resolveShopId(shop));
}
