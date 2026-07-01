// Owned store-action primitives (platform pivot Step 9). When a shop is at org_mode=live,
// the store executors route their terminal write here instead of the Shopify Admin API:
//   - price  -> variant_dim.retail_price_cents (via catalog.setVariantPrice, which also
//               re-projects sku_dim so storefront/engine reads see the new price)
//   - stock  -> the Slice-2 inventory engine (an atomic, cannot-oversell transfer)
// getOwnedVariantPricing resolves the owned variant id + current owned price for a SKU code,
// the owned analogue of reading the live Shopify price (anchors the guardrail cap on the
// owned branch -- the routing changes the WRITE target, not the safety envelope).

import { getSupabase } from "~/lib/supabase.server";
import { setVariantPrice } from "../catalog/catalog.server";
import { createTransfer } from "../inventory/engine.server";

/** Resolve a SKU code to its owned variant id + current retail price (cents), shop-scoped.
 *  Returns null when the SKU isn't owned by this shop or has no owned price to adjust. */
export async function getOwnedVariantPricing(
  shopId: string,
  skuCode: string,
): Promise<{ variantId: string; currentPriceCents: number } | null> {
  const sb = getSupabase();
  const { data: sku, error: sErr } = await sb
    .from("sku_dim")
    .select("id")
    .eq("shop_id", shopId)
    .eq("sku", skuCode)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!sku?.id) return null;
  const variantId = String(sku.id);

  // sku_dim.id == variant_dim.id (repo invariant); the retail price lives on variant_dim.
  const { data: v, error: vErr } = await sb
    .from("variant_dim")
    .select("retail_price_cents")
    .eq("shop_id", shopId)
    .eq("id", variantId)
    .maybeSingle();
  if (vErr) throw vErr;
  if (v?.retail_price_cents == null) return null;
  return { variantId, currentPriceCents: Number(v.retail_price_cents) };
}

/** Owned price write. Delegates to the catalog primitive (update + sku_dim reprojection). */
export async function setOwnedVariantPrice(
  shopId: string,
  variantId: string,
  priceCents: number,
): Promise<{ priorPriceCents: number | null }> {
  return setVariantPrice(shopId, variantId, priceCents);
}

/**
 * Resolve the owned handles for an inventory move that arrives keyed by Shopify refs
 * (the alert-evidence shape): inventory item GID -> owned variant id (sku_dim keeps the
 * inventory_item_id column, sku_dim.id == variant_dim.id), location GIDs -> owned
 * location ids. Returns null when any piece isn't linked for this shop — the caller
 * decides whether that blocks (live) or is recorded as a skipped mirror (dual_run).
 */
export async function resolveOwnedMoveTarget(
  shopId: string,
  opts: { inventoryItemId: string; fromLocationGid: string; toLocationGid: string },
): Promise<{ variantId: string; fromLocationId: string; toLocationId: string } | null> {
  const sb = getSupabase();

  const { data: sku, error: sErr } = await sb
    .from("sku_dim")
    .select("id")
    .eq("shop_id", shopId)
    .eq("inventory_item_id", opts.inventoryItemId)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!sku?.id) return null;

  const { data: locs, error: lErr } = await sb
    .from("location_dim")
    .select("id, external_id")
    .eq("shop_id", shopId)
    .in("external_id", [opts.fromLocationGid, opts.toLocationGid]);
  if (lErr) throw lErr;
  const rows = (locs ?? []) as Array<{ id: string; external_id: string }>;
  const from = rows.find((l) => l.external_id === opts.fromLocationGid);
  const to = rows.find((l) => l.external_id === opts.toLocationGid);
  if (!from || !to) return null;

  return { variantId: String(sku.id), fromLocationId: String(from.id), toLocationId: String(to.id) };
}

/** Owned inventory move: an instant location->location transfer through the atomic
 *  (cannot-oversell) inventory engine. Keyed by owned variant id + owned location ids. */
export async function applyOwnedInventoryMove(opts: {
  shopId: string;
  variantId: string;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
}): Promise<{ transferId: string }> {
  return createTransfer(
    opts.shopId,
    opts.variantId,
    opts.fromLocationId,
    opts.toLocationId,
    opts.quantity,
    "instant",
  );
}
