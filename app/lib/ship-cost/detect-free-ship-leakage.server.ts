// Server-side detector for free_shipping_leakage. Loads order_fact + related
// tables for a shop, delegates to the pure clustering function, then upserts
// one alerts row per actionable cluster.
//
// Upsert key: (shop_id, detector_id, entity_ref) — entity_ref is stored as a
// JSONB column in the DB, cast to text for the conflict target. The caller
// (api/engine/run) collects returned alert IDs for the cron summary.

import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyZone } from "./zone";
import { detectFreeShipLeakage } from "./detect-free-ship-leakage";
import type { ShipLeakOrder, ShipLeakLine } from "./detect-free-ship-leakage";
import type { ShipCostConfidence } from "./types";

interface OrderFactRow {
  id: string;
  shipping_cents: number;
  ship_cost_cents: number;
  ship_cost_confidence: string | null;
  customer_country: string | null;
}

interface OrderLineFactRow {
  order_id: string;
  sku_id: string | null;
  grams: number | null;
  quantity: number;
}

interface SkuDimRow {
  id: string;
  sku: string;
}

interface ShopRow {
  id: string;
  country: string | null;
}

/**
 * Run the free-shipping-leakage detector for one shop. Returns the number of
 * alert rows upserted (0 means nothing cleared the floor/confidence bar).
 */
export async function runFreeShipLeakageDetect(
  sb: SupabaseClient,
  shopId: string,
): Promise<number> {
  // 1. Load shop origin country for zone classification.
  const { data: shopData } = await sb.from("shops").select("id, country").eq("id", shopId);
  const shopRows = (shopData ?? []) as ShopRow[];
  const shopCountry = shopRows[0]?.country ?? null;

  // 2. Load order_fact rows for this shop. We pull all rows and filter
  //    free-shipping orders in JS (the pure function also re-gates on
  //    FREE_SHIP_THRESHOLD_CENTS so this is safe with any filter order).
  const { data: orderData } = await sb
    .from("order_fact")
    .select("id, shipping_cents, ship_cost_cents, ship_cost_confidence, customer_country")
    .eq("shop_id", shopId);
  const orderRows = (orderData ?? []) as OrderFactRow[];
  if (orderRows.length === 0) return 0;

  // 3. Load all order_line_fact rows for this shop.
  const { data: lineData } = await sb
    .from("order_line_fact")
    .select("order_id, sku_id, grams, quantity")
    .eq("shop_id", shopId);
  const lineRows = (lineData ?? []) as OrderLineFactRow[];

  // 4. Load sku_dim so we can resolve sku_id → human SKU code.
  const { data: skuData } = await sb.from("sku_dim").select("id, sku").eq("shop_id", shopId);
  const skuDimRows = (skuData ?? []) as SkuDimRow[];
  const skuCodeById = new Map<string, string>();
  for (const s of skuDimRows) skuCodeById.set(s.id, s.sku);

  // Group lines by order_id.
  const linesByOrder = new Map<string, OrderLineFactRow[]>();
  for (const l of lineRows) {
    if (!l.sku_id) continue;
    const bucket = linesByOrder.get(l.order_id) ?? [];
    bucket.push(l);
    linesByOrder.set(l.order_id, bucket);
  }

  // 5. Build ShipLeakOrder inputs for the pure function.
  const leakOrders: ShipLeakOrder[] = orderRows.map((o) => {
    const lines: ShipLeakLine[] = (linesByOrder.get(o.id) ?? []).map((l) => ({
      skuId: l.sku_id!,
      grams: l.grams,
      quantity: l.quantity,
    }));
    return {
      orderId: o.id,
      lines,
      shippingCents: o.shipping_cents ?? 0,
      shipCostCents: o.ship_cost_cents ?? 0,
      shipCostConfidence: (o.ship_cost_confidence as ShipCostConfidence) ?? "low",
      zone: classifyZone(shopCountry, o.customer_country),
    };
  });

  // 6. Run the pure clustering function.
  const clusters = detectFreeShipLeakage(leakOrders);
  if (clusters.length === 0) return 0;

  // 7. Build alert rows. DB dollar_impact column stores DOLLARS (rowToAlert
  //    converts to cents at read time). entity_ref is a JSONB object that
  //    includes `kind` + the identifying dimension.
  const nowIso = new Date().toISOString();
  const alertRows = clusters.map((c) => {
    const skuCode = c.kind === "sku" ? (skuCodeById.get(c.id) ?? c.id) : null;
    const entityRef =
      c.kind === "sku"
        ? { kind: "sku" as const, sku_id: c.id, sku: skuCode ?? c.id }
        : { kind: "zone" as const, zone: c.id };

    const evidence: Record<string, unknown> = {
      ship_cost_confidence: c.shipCostConfidence,
      shipping_collected_usd: +(c.shippingCollectedCents / 100).toFixed(2),
      ship_cost_usd: +(c.shipCostCents / 100).toFixed(2),
      net_shipping_pnl_usd: +((c.shippingCollectedCents - c.shipCostCents) / 100).toFixed(2),
      free_ship_orders: c.freeShipOrders,
    };
    if (c.kind === "sku" && skuCode) {
      evidence.sku = skuCode;
      evidence.sku_id = c.id;
    }
    if (c.kind === "zone") {
      evidence.zone = c.id;
    }

    return {
      shop_id: shopId,
      detector_id: "free_shipping_leakage" as const,
      severity: c.severity,
      status: "open" as const,
      // DB column is dollars; rowToAlert multiplies by 100 to get cents.
      dollar_impact: +(c.bleedCents / 100).toFixed(2),
      entity_ref: entityRef,
      evidence,
      title:
        c.kind === "sku"
          ? `Free shipping on ${skuCode ?? c.id} costs more than it earns`
          : `Free shipping in zone "${c.id}" costs more than it earns`,
      narrative:
        c.kind === "sku"
          ? `${skuCode ?? c.id} has ${c.freeShipOrders} free-shipping order${c.freeShipOrders === 1 ? "" : "s"} that cost $${(c.shipCostCents / 100).toFixed(0)} to ship but collected only $${(c.shippingCollectedCents / 100).toFixed(0)}, bleeding $${(c.bleedCents / 100).toFixed(0)}.`
          : `Zone "${c.id}" free-shipping orders cost $${(c.shipCostCents / 100).toFixed(0)} but collected $${(c.shippingCollectedCents / 100).toFixed(0)}, bleeding $${(c.bleedCents / 100).toFixed(0)}.`,
      created_at: nowIso,
      claude_rank: 500,
    };
  });

  // 8. Upsert on (shop_id, detector_id, entity_ref). entity_ref is cast to
  //    text by Postgres for the conflict target — the supabase-js client
  //    sends the raw JSON value and Postgres casts it.
  const { error } = await sb
    .from("alerts")
    .upsert(alertRows, { onConflict: "shop_id,detector_id,entity_ref" });
  if (error) {
    console.error("[detect-free-ship-leakage] upsert failed", error);
    throw error;
  }

  return alertRows.length;
}
