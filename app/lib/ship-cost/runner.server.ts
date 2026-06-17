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
  ship_cost_manual_cents: number | null;
}

export async function runShipCostResolution(
  sb: SupabaseClient,
  shopId: string,
  opts: RunnerOpts,
): Promise<void> {
  const { data: orders } = await sb
    .from("v_order_ship_features")
    .select("id, customer_country, grams_sum, item_count, fulfillment_count, ship_cost_manual_cents")
    .eq("shop_id", shopId);
  const orderRows = (orders ?? []) as OrderFeatureRow[];
  if (orderRows.length === 0) return;

  if (opts.shopCountry == null) {
    console.warn(`[ship-cost] shop ${shopId}: no origin country; all orders treated as domestic zone (allocation degraded)`);
  }

  const { data: periods } = await sb
    .from("shipping_cost_period").select("total_cents").eq("shop_id", shopId)
    // Allocation fence (C6): synthetic source='connector' periods carry real
    // per-order carrier money already landed as shipping_invoice_line rows; they
    // must NOT inflate the period-allocation pool (which spreads over EVERY order),
    // else carrier money leaks onto orders that never had a carrier shipment.
    .in("source", ["upload", "typed"]);
  const periodRows = (periods ?? []) as { total_cents: number }[];
  const periodTotal =
    periodRows.reduce((s, p) => s + (p.total_cents ?? 0), 0) || null;

  // Source-priority reconciliation (Phase 3, priority 1): an order can carry BOTH a
  // CSV-upload invoice line AND a connector line (e.g. EasyPost). The old code built
  // invoiceByOrder with a plain last-write-wins Map over an UNORDERED select, so which
  // cost won was nondeterministic (row order is not guaranteed). Join each line to its
  // period's source and apply a deterministic precedence — connector > upload > typed —
  // keeping last-write-wins only WITHIN the same source (unchanged behavior there).
  // The connector line is the truest per-order cost (a real per-shipment carrier charge),
  // so it must outrank a hand-built CSV line for the same order.
  const { data: periodSources } = await sb
    .from("shipping_cost_period").select("id, source").eq("shop_id", shopId);
  const sourceByPeriod = new Map<string, string>();
  for (const p of (periodSources ?? []) as { id: string; source: string | null }[]) {
    sourceByPeriod.set(String(p.id), String(p.source ?? ""));
  }
  // Higher number = higher precedence. An unknown/absent source ranks lowest (0) so a
  // line with a recognized source always wins over one with none.
  const SOURCE_RANK: Record<string, number> = { connector: 3, upload: 2, typed: 1 };
  const sourceRank = (src: string | undefined): number => (src ? SOURCE_RANK[src] ?? 0 : 0);
  const CONNECTOR_RANK = SOURCE_RANK.connector;

  const { data: invoices } = await sb
    .from("shipping_invoice_line").select("matched_order_id, cost_cents, period_id").eq("shop_id", shopId);
  const invoiceByOrder = new Map<string, number>();
  const winningRankByOrder = new Map<string, number>();
  for (const i of (invoices ?? []) as {
    matched_order_id: string | null;
    cost_cents: number;
    period_id: string | null;
  }[]) {
    if (!i.matched_order_id) continue;
    const orderId = i.matched_order_id;
    const rank = sourceRank(i.period_id ? sourceByPeriod.get(String(i.period_id)) : undefined);
    const prev = winningRankByOrder.get(orderId);
    if (prev === undefined || rank > prev) {
      // First line for this order, or one from a strictly higher source → it becomes the
      // new basis (any lower-ranked contribution already accumulated is discarded).
      invoiceByOrder.set(orderId, i.cost_cents);
      winningRankByOrder.set(orderId, rank);
    } else if (rank === prev) {
      if (rank === CONNECTOR_RANK) {
        // Connector lines are landed one-per-charge (land.server.ts), so an order's true
        // per-shipment cost is the SUM of its connector lines — accumulate them. This is
        // order-independent and reads ALL lines (no window), so straddling re-pull windows
        // can't double-count or under-count (the idempotency fix).
        invoiceByOrder.set(orderId, (invoiceByOrder.get(orderId) ?? 0) + i.cost_cents);
      } else {
        // upload / typed: last-write-wins within the same source (unchanged pre-Phase-3
        // behavior — those sources land one already-summed line per order).
        invoiceByOrder.set(orderId, i.cost_cents);
      }
    }
    // rank < prev → ignore (a lower source never overwrites a higher one).
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

  // Bounded per-shop serial updates; if order volume grows, batch via an RPC or add a LIMIT to v_order_ship_features.
  for (const o of orderRows) {
    const r = resolveOrderShipCost({
      manualOverrideCents: o.ship_cost_manual_cents ?? null,
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
    // created_at_source is UTC ISO-8601; sku_pnl.day must be UTC-keyed for this join to match (same convention as revenue.server.ts).
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
    if (shipCostCents === 0) continue;
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
