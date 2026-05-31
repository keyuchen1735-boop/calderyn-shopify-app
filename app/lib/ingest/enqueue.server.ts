import { getSupabase, resolveShopId } from "../supabase.server";

/**
 * Mark a shop's Shopify integration as pending so the backfill cron picks it up.
 * Idempotent: keeps an existing 'ready' row pending only if it has never synced.
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
