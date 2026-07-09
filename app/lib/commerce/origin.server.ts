// app/lib/commerce/origin.server.ts
// Ship-from origin resolution: stored shop_origin -> Shopify shop.billingAddress (cached on
// first read) -> require-setup. The shipping engine cannot quote without an origin, so an
// unconfigured shop fails VISIBLY (rule 12) rather than quoting from a guessed address.
import type { Address } from "~/lib/ship-cost/adapters/rate-quote";
import { getSupabase } from "~/lib/supabase.server";
import { fetchShopifyShopAddress } from "./shopify-shop-address.server";
import { OriginNotConfiguredError } from "./errors";

// Re-exported from the dependency-free errors module so existing importers keep
// working while routes can catch by instanceof without this file's import graph.
export { OriginNotConfiguredError };

function isComplete(a: Partial<Address> | null): a is Address {
  return !!(a && a.street1 && a.city && a.state && a.zip && a.country);
}

export async function getShopOrigin(shopId: string): Promise<Address> {
  if (!shopId) throw new Error("shopId is required");
  const sb = getSupabase();

  const stored = await sb
    .from("shop_origin")
    .select("name, street1, street2, city, state, zip, country")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (stored.error) throw stored.error;
  if (isComplete(stored.data as Partial<Address> | null)) return stored.data as Address;

  // Not stored — pull from Shopify and cache it.
  const fromShopify = await fetchShopifyShopAddress(shopId);
  if (isComplete(fromShopify)) {
    await sb.from("shop_origin").upsert(
      { shop_id: shopId, ...fromShopify, source: "shopify", updated_at: new Date().toISOString() },
      { onConflict: "shop_id" },
    );
    return fromShopify;
  }

  throw new OriginNotConfiguredError(shopId);
}
