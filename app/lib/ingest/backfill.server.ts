import { getSupabase, resolveShopId } from "../supabase.server";
import { writeDlq } from "./dlq.server";
import { fetchLocations, fetchProducts, fetchRecentOrders } from "./shopify-admin.server";
import { mapLocation, mapVariantToSku, mapOrder, mapOrderLines } from "./mappers.server";
import type { InventoryRow } from "./types";

const BACKFILL_DAYS = 30;

export type BackfillResult = {
  shopDomain: string;
  locations: number;
  skus: number;
  inventory: number;
  orders: number;
};

export async function backfillShop(shopDomain: string): Promise<BackfillResult> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shopDomain);
  const result: BackfillResult = { shopDomain, locations: 0, skus: 0, inventory: 0, orders: 0 };

  try {
    // 1. Locations
    const locations = (await fetchLocations(shopDomain)).map((n) => mapLocation(shopId, n));
    if (locations.length) {
      const { error } = await sb.from("location_dim").upsert(locations, { onConflict: "shop_id,external_id" });
      if (error) throw error;
      result.locations = locations.length;
    }
    // location external_id -> uuid map for inventory rows
    const { data: locRows, error: locErr } = await sb
      .from("location_dim")
      .select("id, external_id")
      .eq("shop_id", shopId);
    if (locErr) throw locErr;
    const locMap = new Map((locRows ?? []).map((r) => [r.external_id as string, r.id as string]));

    // 2. Products + variants + inventory
    const now = new Date().toISOString();
    for await (const product of fetchProducts(shopDomain)) {
      const skuRows = product.variants.nodes.map((v) => mapVariantToSku(shopId, product, v));
      if (!skuRows.length) continue;
      const { data: upserted, error: skuErr } = await sb
        .from("sku_dim")
        .upsert(skuRows, { onConflict: "shop_id,external_id" })
        .select("id, external_id");
      if (skuErr) throw skuErr;
      result.skus += upserted?.length ?? 0;
      const skuMap = new Map((upserted ?? []).map((r) => [r.external_id as string, r.id as string]));

      const invRows: InventoryRow[] = [];
      for (const v of product.variants.nodes) {
        const skuId = skuMap.get(v.id);
        if (!skuId) continue;
        for (const lvl of v.inventoryItem?.inventoryLevels.nodes ?? []) {
          const locId = locMap.get(lvl.location.id);
          if (!locId) continue;
          const available = lvl.quantities.find((q) => q.name === "available")?.quantity ?? 0;
          invRows.push({
            shop_id: shopId,
            sku_id: skuId,
            location_id: locId,
            available,
            observed_at: now,
            source_version: Date.parse(now),
          });
        }
      }
      if (invRows.length) {
        const { error: invErr } = await sb
          .from("inventory_level_fact")
          .upsert(invRows, { onConflict: "sku_id,location_id,source_version", ignoreDuplicates: true });
        if (invErr) throw invErr;
        result.inventory += invRows.length;
      }
    }

    // variant GID -> sku uuid map (for order lines)
    const { data: allSkus, error: allSkuErr } = await sb
      .from("sku_dim")
      .select("id, external_id")
      .eq("shop_id", shopId);
    if (allSkuErr) throw allSkuErr;
    const variantToSku = new Map((allSkus ?? []).map((r) => [r.external_id as string, r.id as string]));

    // 3. Orders (last 30 days)
    const since = new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString();
    for await (const order of fetchRecentOrders(shopDomain, since)) {
      const orderRow = mapOrder(shopId, order);
      const { data: oUp, error: oErr } = await sb
        .from("order_fact")
        .upsert(orderRow, { onConflict: "shop_id,external_id" })
        .select("id")
        .single();
      if (oErr) throw oErr;
      result.orders += 1;
      const lineRows = mapOrderLines(order).map((l) => ({
        shop_id: shopId,
        order_id: (oUp as { id: string }).id,
        sku_id: l.sku_external_id ? variantToSku.get(l.sku_external_id) ?? null : null,
        external_line_id: l.external_line_id,
        quantity: l.quantity,
        price_cents: l.price_cents,
        total_cents: l.total_cents,
      }));
      if (lineRows.length) {
        const { error: lErr } = await sb
          .from("order_line_fact")
          .upsert(lineRows, { onConflict: "order_id,external_line_id" });
        if (lErr) throw lErr;
      }
    }

    await sb
      .from("shop_integrations")
      .update({
        sync_status: "ready",
        sync_error: null,
        last_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("shop_id", shopId)
      .eq("kind", "shopify");

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeDlq({
      shopId,
      jobKind: "backfill",
      errorKind: "backfill_failed",
      errorMessage: message,
      payload: { shopDomain },
    });
    await sb
      .from("shop_integrations")
      .update({
        sync_status: "error",
        sync_error: message.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("shop_id", shopId)
      .eq("kind", "shopify");
    throw err;
  }
}
