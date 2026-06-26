import { getSupabase, resolveShopId } from "../supabase.server";

/**
 * Mark a shop's Shopify integration as pending so the backfill cron picks it up.
 * Called from afterAuth, so it fires on every (re-)auth and unconditionally
 * resets sync_status to 'pending' — i.e. a re-auth re-triggers a full backfill.
 * That is acceptable for Slice 1 because the backfill upserts are idempotent
 * (no duplicate facts); the cost is a redundant re-sync, not bad data.
 */
export async function enqueueShopifyBackfill(shopDomain: string): Promise<void> {
  const shopId = await resolveShopId(shopDomain);
  const sb = getSupabase();
  const { error } = await sb.from("shop_integrations").upsert(
    {
      shop_id: shopId,
      kind: "shopify",
      scopes: ["read_products", "read_inventory", "read_orders", "read_locations"],
      sync_status: "pending",
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "shop_id,kind", ignoreDuplicates: false },
  );
  if (error) throw error;
}

/**
 * True when this shop has never completed a Shopify backfill — i.e. a first
 * install (or a prior install whose backfill never finished). `last_sync_at` is
 * only stamped by a successful backfillShop, so a null/absent value is the
 * signal. afterAuth uses this to run the first backfill inline (instead of
 * waiting for the /cron/ingest tick) without repeating a full sync on every
 * routine re-auth/token-exchange.
 */
export async function shopifyNeverSynced(shopDomain: string): Promise<boolean> {
  const shopId = await resolveShopId(shopDomain);
  const sb = getSupabase();
  const { data, error } = await sb
    .from("shop_integrations")
    .select("last_sync_at")
    .eq("shop_id", shopId)
    .eq("kind", "shopify")
    .maybeSingle();
  if (error) throw error;
  return !data || data.last_sync_at == null;
}
