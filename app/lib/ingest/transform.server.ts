import { getSupabase } from "../supabase.server";
import { writeDlq } from "./dlq.server";
import { parseInventoryWebhook, parseOrderWebhook } from "./mappers.server";

const BATCH = 200;

// Shopify's authenticate.webhook() returns topics in storage form
// (topic.toUpperCase().replace(/\/|\./g, '_')) — e.g. "ORDERS_CREATE", not
// "orders/create" — and that is what lands in raw_shopify_webhook.topic.
// Canonicalize before dispatch so we match regardless of the stored casing.
const TOPIC_INVENTORY_UPDATE = "INVENTORY_LEVELS_UPDATE";
const TOPIC_ORDERS_CREATE = "ORDERS_CREATE";
const TOPIC_PRODUCTS_UPDATE = "PRODUCTS_UPDATE";

export function canonicalTopic(topic: string): string {
  return topic.toUpperCase().replace(/[/.]/g, "_");
}

export type TransformResult = { processed: number; facts: number; dlq: number };

export async function transformPendingWebhooks(): Promise<TransformResult> {
  const sb = getSupabase();
  const res: TransformResult = { processed: 0, facts: 0, dlq: 0 };

  const { data: rows, error } = await sb
    .from("raw_shopify_webhook")
    .select("id, shop_id, topic, payload")
    .is("processed_at", null)
    .order("received_at", { ascending: true })
    .limit(BATCH);
  if (error) throw error;

  for (const row of rows ?? []) {
    try {
      const topic = canonicalTopic(String(row.topic));
      if (topic === TOPIC_INVENTORY_UPDATE) {
        res.facts += await applyInventory(row.shop_id, row.payload as Record<string, unknown>);
      } else if (topic === TOPIC_ORDERS_CREATE) {
        res.facts += await applyOrder(row.shop_id, row.payload as Record<string, unknown>);
      } else if (topic !== TOPIC_PRODUCTS_UPDATE) {
        // products/update is intentionally handled by backfill upserts in Slice 1.
        // Any other topic is unexpected — stamp it so it doesn't loop, but stay
        // visible (rule 12) rather than silently dropping it.
        console.warn(`[ingest] transform: skipping unhandled webhook topic ${row.topic}`);
      }
      await sb
        .from("raw_shopify_webhook")
        .update({ processed_at: new Date().toISOString() })
        .eq("id", row.id);
      res.processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await writeDlq({
        shopId: row.shop_id,
        jobKind: `transform:${row.topic}`,
        errorKind: "transform_failed",
        errorMessage: message,
        payload: row.payload,
      });
      await sb
        .from("raw_shopify_webhook")
        .update({ processed_at: new Date().toISOString() })
        .eq("id", row.id);
      res.dlq += 1;
    }
  }
  return res;
}

async function applyInventory(shopId: string, payload: Record<string, unknown>): Promise<number> {
  const sb = getSupabase();
  const p = parseInventoryWebhook(payload);

  const { data: sku } = await sb
    .from("sku_dim")
    .select("id")
    .eq("shop_id", shopId)
    .eq("inventory_item_id", p.inventory_item_external_id)
    .maybeSingle();
  const { data: loc } = await sb
    .from("location_dim")
    .select("id")
    .eq("shop_id", shopId)
    .eq("external_id", p.location_external_id)
    .maybeSingle();

  if (!sku || !loc) {
    throw new Error(
      `unresolved sku/location for inventory webhook (${p.inventory_item_external_id})`,
    );
  }

  const skuId = (sku as { id: string }).id;
  const locId = (loc as { id: string }).id;

  const { error } = await sb.from("inventory_level_fact").upsert(
    {
      shop_id: shopId,
      sku_id: skuId,
      location_id: locId,
      available: p.available,
      observed_at: p.observed_at,
      source_version: p.source_version,
    },
    { onConflict: "sku_id,location_id,source_version", ignoreDuplicates: true },
  );
  if (error) throw error;
  return 1;
}

async function applyOrder(shopId: string, payload: Record<string, unknown>): Promise<number> {
  const sb = getSupabase();
  const { order, lines } = parseOrderWebhook(payload as Parameters<typeof parseOrderWebhook>[0]);

  // Slice-1: last-writer-wins (see backfill.server.ts note on §7.1 deviation).
  const { data: oUp, error: oErr } = await sb
    .from("order_fact")
    .upsert({ shop_id: shopId, ...order }, { onConflict: "shop_id,external_id" })
    .select("id")
    .single();
  if (oErr) throw oErr;

  const orderId = (oUp as { id: string }).id;

  if (!lines.length) return 1;

  const { data: skus } = await sb
    .from("sku_dim")
    .select("id, external_id")
    .eq("shop_id", shopId);
  const variantToSku = new Map(
    (skus ?? []).map((r) => [
      (r as { external_id: string; id: string }).external_id,
      (r as { external_id: string; id: string }).id,
    ]),
  );

  const lineRows = lines.map((l) => ({
    shop_id: shopId,
    order_id: orderId,
    sku_id: l.sku_external_id ? (variantToSku.get(l.sku_external_id) ?? null) : null,
    external_line_id: l.external_line_id,
    quantity: l.quantity,
    price_cents: l.price_cents,
    total_cents: l.total_cents,
  }));

  const { error: lErr } = await sb
    .from("order_line_fact")
    .upsert(lineRows, { onConflict: "order_id,external_line_id" });
  if (lErr) throw lErr;

  return 1 + lineRows.length;
}
