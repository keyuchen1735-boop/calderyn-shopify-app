import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyZone, zoneMultiplier } from "./zone";
import { allocatePeriodTotal, type AllocOrder } from "./allocate";
import { splitOrderShipCost, type SplitLine } from "./split";
import { resolveOrderShipCost } from "./resolve";
import type { OrderSignals } from "./types";

interface RunnerOpts { shopCountry: string | null; }

interface OrderFeatureRow {
  id: string;
  customer_country: string | null;
  grams_sum: number | null;
  item_count: number | null;
  fulfillment_count: number | null;
}

export async function runShipCostResolution(
  sb: SupabaseClient,
  shopId: string,
  opts: RunnerOpts,
): Promise<void> {
  const { data: orders } = await sb
    .from("v_order_ship_features")
    .select("id, customer_country, grams_sum, item_count, fulfillment_count")
    .eq("shop_id", shopId);
  const orderRows = (orders ?? []) as OrderFeatureRow[];
  if (orderRows.length === 0) return;

  const { data: periods } = await sb
    .from("shipping_cost_period").select("total_cents").eq("shop_id", shopId);
  const periodTotal =
    (periods ?? []).reduce((s, p) => s + ((p as { total_cents: number }).total_cents ?? 0), 0) || null;

  const { data: invoices } = await sb
    .from("shipping_invoice_line").select("matched_order_id, cost_cents").eq("shop_id", shopId);
  const invoiceByOrder = new Map<string, number>();
  for (const i of (invoices ?? []) as { matched_order_id: string | null; cost_cents: number }[]) {
    if (i.matched_order_id) invoiceByOrder.set(i.matched_order_id, i.cost_cents);
  }

  const allocOrders: AllocOrder[] = orderRows.map((o) => ({
    orderId: o.id,
    grams: o.grams_sum,
    itemCount: o.item_count ?? 1,
    zoneMultiplier: zoneMultiplier(classifyZone(opts.shopCountry, o.customer_country)),
    fulfillmentCount: o.fulfillment_count ?? 1,
  }));
  const allocated = periodTotal ? allocatePeriodTotal(allocOrders, periodTotal) : null;
  const coverage: OrderSignals["allocationCoverage"] =
    allocOrders.every((o) => o.grams != null) ? "full"
    : allocOrders.some((o) => o.grams != null) ? "partial" : "none";
  const fallbackFlat = periodTotal ? Math.round(periodTotal / orderRows.length) : 0;
  const nowIso = new Date().toISOString();

  for (const o of orderRows) {
    const r = resolveOrderShipCost({
      manualOverrideCents: null,
      invoiceLineCents: invoiceByOrder.get(o.id) ?? null,
      eventParsedCents: null,
      allocatedCents: allocated?.get(o.id) ?? null,
      modeledCents: null,
      fallbackCents: fallbackFlat,
      allocationCoverage: coverage,
    });
    await sb.from("order_fact").update({
      ship_cost_cents: r.cents,
      ship_cost_source: r.source,
      ship_cost_confidence: r.confidence,
      ship_cost_reconciled_at: nowIso,
    }).eq("id", o.id).eq("shop_id", shopId);
  }

  await rollShipCostIntoSkuPnl(sb, shopId);
}

interface OrderFactRow {
  id: string;
  created_at_source: string;
  ship_cost_cents: number;
}

interface OrderLineRow {
  id: string;
  order_id: string;
  sku_id: string | null;
  grams: number | null;
  quantity: number;
}

interface SkuPnlRow {
  id: string;
  sku_id: string;
  day: string;
  revenue_cents: number;
  cogs_cents: number;
  ad_spend_attrib_cents: number;
  return_cents: number;
}

export async function rollShipCostIntoSkuPnl(
  sb: SupabaseClient,
  shopId: string,
): Promise<void> {
  // Load orders that have a resolved ship cost
  const { data: orderData } = await sb
    .from("order_fact")
    .select("id, created_at_source, ship_cost_cents")
    .eq("shop_id", shopId)
    .not("ship_cost_cents", "is", null);
  const orderFacts = (orderData ?? []) as OrderFactRow[];
  if (orderFacts.length === 0) return;

  // Load all order lines for the shop
  const { data: lineData } = await sb
    .from("order_line_fact")
    .select("id, order_id, sku_id, grams, quantity")
    .eq("shop_id", shopId);
  const orderLines = (lineData ?? []) as OrderLineRow[];

  // Group lines by order_id
  const linesByOrder = new Map<string, OrderLineRow[]>();
  for (const line of orderLines) {
    const bucket = linesByOrder.get(line.order_id) ?? [];
    bucket.push(line);
    linesByOrder.set(line.order_id, bucket);
  }

  // Accumulate ship_cost_cents keyed by (sku_id, day)
  const shipCostBySkuDay = new Map<string, number>();
  for (const order of orderFacts) {
    const lines = linesByOrder.get(order.id) ?? [];
    if (lines.length === 0) continue;
    const splitLines: SplitLine[] = lines.map((l) => ({
      lineId: l.id,
      grams: l.grams,
      quantity: l.quantity,
    }));
    const split = splitOrderShipCost(order.ship_cost_cents, splitLines);
    const day = order.created_at_source.slice(0, 10);
    for (const line of lines) {
      if (!line.sku_id) continue;
      const lineCents = split.get(line.id) ?? 0;
      const key = `${line.sku_id}|${day}`;
      shipCostBySkuDay.set(key, (shipCostBySkuDay.get(key) ?? 0) + lineCents);
    }
  }

  // Load existing sku_pnl rows and update ship_cost_cents + contribution_margin_cents
  const { data: pnlData } = await sb
    .from("sku_pnl")
    .select("id, sku_id, day, revenue_cents, cogs_cents, ad_spend_attrib_cents, return_cents")
    .eq("shop_id", shopId);
  const pnlRows = (pnlData ?? []) as SkuPnlRow[];

  for (const row of pnlRows) {
    const key = `${row.sku_id}|${row.day}`;
    const shipCostCents = shipCostBySkuDay.get(key) ?? 0;
    const contributionMarginCents =
      row.revenue_cents -
      row.cogs_cents -
      row.ad_spend_attrib_cents -
      row.return_cents -
      shipCostCents;
    await sb
      .from("sku_pnl")
      .update({ ship_cost_cents: shipCostCents, contribution_margin_cents: contributionMarginCents })
      .eq("id", row.id)
      .eq("shop_id", shopId);
  }
}
