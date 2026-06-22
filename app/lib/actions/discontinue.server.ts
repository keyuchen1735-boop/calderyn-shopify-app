// app/lib/actions/discontinue.server.ts
// Internal-flag side of the discontinue_sku executor: resolve the SKU's Shopify
// product GID + current flag state from sku_dim (shop-scoped — the ownership
// guard), and flip the do_not_reorder flag. Both are pure DB ops; the Shopify
// write lives in shopify/product.server.ts and the orchestration in
// alert-action.server.ts.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ResolvedDiscontinueTarget {
  skuId: string;
  /** Shopify Product GID, or null when sku_dim has no product_id (no archive
   *  possible — the gateway surfaces this rather than offering a dead button). */
  productGid: string | null;
  alreadyFlagged: boolean;
}

/** Resolve a SKU code to its internal id + Shopify product GID + current flag,
 *  shop-scoped. Returns null when the code isn't owned by the shop. */
export async function resolveSkuForDiscontinue(
  sb: SupabaseClient,
  shopId: string,
  skuCode: string,
): Promise<ResolvedDiscontinueTarget | null> {
  const { data, error } = await sb
    .from("sku_dim")
    .select("id, product_id, do_not_reorder")
    .eq("shop_id", shopId)
    .eq("sku", skuCode)
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) return null;
  return {
    skuId: String(data.id),
    productGid: data.product_id ? String(data.product_id) : null,
    alreadyFlagged: data.do_not_reorder === true,
  };
}

/** Set/clear the internal do_not_reorder flag, shop + sku scoped. */
export async function setDoNotReorder(
  sb: SupabaseClient,
  shopId: string,
  skuId: string,
  value: boolean,
): Promise<void> {
  const { error } = await sb
    .from("sku_dim")
    .update({ do_not_reorder: value })
    .eq("shop_id", shopId)
    .eq("id", skuId);
  if (error) throw error;
}
