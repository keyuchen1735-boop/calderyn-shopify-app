import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyZone, zoneMultiplier } from "./zone";
import { allocatePeriodTotal, type AllocOrder } from "./allocate";
import { splitOrderShipCost, type SplitLine } from "./split";
import { resolveOrderShipCost } from "./resolve";
import { modelOrderShipCost } from "./model";
import type { OrderSignals } from "./types";

interface RunnerOpts { shopCountry: string | null; }

// Payload rows for the two set-based apply RPCs. Field names must match the
// jsonb_to_recordset column lists in 20260702000000_ship_cost_batch_apply.sql
// exactly — a mismatched key would silently land as NULL server-side, which is
// why these are typed interfaces rather than Record<string, unknown>.
interface OrderShipCostUpdate {
  id: string;
  ship_cost_cents: number;
  ship_cost_source: string;
  ship_cost_confidence: string;
  ship_cost_reconciled_at: string;
}

interface SkuPnlUpdate {
  id: string;
  ship_cost_cents: number;
  contribution_margin_cents: number;
}

// PostgREST silently truncates an uncapped select at 1000 rows by default, so a
// shop with more orders than that would only be partially resolved per tick
// (proven in prod: a cron tick stopped at exactly 1000 orders/shop). Page through
// the full result set in range windows until a short page signals the end, rather
// than betting on a fixed .limit() that a high-volume shop could still outgrow.
const PAGE_SIZE = 1000;

// Writes go through set-based RPCs in batches of this many rows. One round-trip
// per row was the prod 504: ~11k serial order_fact updates per tick across the
// active shops exhausted the cron's 300s function ceiling and starved every
// phase after ship-cost. 1000 rows ≈ ~100KB of jsonb per call — one statement,
// well under any payload or statement-timeout limit.
const RPC_BATCH = 1000;

// Turn a PostgREST/Supabase `{ message, details, hint, code }` failure into a real
// Error with a readable message. Throwing the raw object propagates a non-Error
// that String()s to "[object Object]" at call sites that only handle Error
// instances (e.g. cron.ingest-ship-costs' merchant-visible sync_error write).
// Same rationale as asError in attribution/revenue.server.ts.
function asError(context: string, err: unknown): Error {
  const e = (err ?? {}) as { message?: unknown; details?: unknown; code?: unknown };
  const parts = [e.message, e.details, e.code != null && `code=${e.code}`].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return new Error(`${context}: ${parts.join(" ") || "unknown Supabase error"}`);
}

async function applyInBatches<T extends { id: string }>(
  sb: SupabaseClient,
  fn: string,
  shopId: string,
  rows: T[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += RPC_BATCH) {
    const batch = rows.slice(i, i + RPC_BATCH);
    const { data, error } = await sb.rpc(fn, { p_shop_id: shopId, p_rows: batch });
    // Throw a real Error so the cron route's per-shop catch records a readable
    // message in summary.shipCostErrors.
    if (error) throw asError(`${fn} batch failed`, error);
    // The SQL function returns the updated-row count; fewer than sent means some
    // ids no longer matched (e.g. order deleted between the paged read and this
    // write). Not fatal — those rows re-diff as changed next tick — but silent
    // partial application must at least leave a trace.
    if (typeof data === "number" && data !== batch.length) {
      console.warn(
        `[ship-cost] ${fn}: batch updated ${data}/${batch.length} rows for shop ${shopId}`,
      );
    }
  }
}

async function fetchAllRows<T>(
  label: string,
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await build(from, to);
    // A failed page must be loud: swallowing it returns a partial (or empty) row
    // set, which silently skips resolution — or worse, allocates a period total
    // over a truncated order list, inflating every order that WAS read.
    if (error) throw asError(`${label} read failed`, error);
    const page = (data ?? []) as T[];
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return all;
}

interface OrderFeatureRow {
  id: string;
  customer_country: string | null;
  grams_sum: number | null;
  item_count: number | null;
  fulfillment_count: number | null;
  ship_cost_manual_cents: number | null;
  // Currently-stored resolution (exposed on the view) — compared against this
  // tick's resolution so unchanged orders cost zero writes.
  ship_cost_cents: number | null;
  ship_cost_source: string | null;
  ship_cost_confidence: string | null;
}

export async function runShipCostResolution(
  sb: SupabaseClient,
  shopId: string,
  opts: RunnerOpts,
): Promise<void> {
  const orderRows = await fetchAllRows<OrderFeatureRow>("v_order_ship_features", (from, to) =>
    sb
      .from("v_order_ship_features")
      .select(
        "id, customer_country, grams_sum, item_count, fulfillment_count, ship_cost_manual_cents, ship_cost_cents, ship_cost_source, ship_cost_confidence",
      )
      .eq("shop_id", shopId)
      .range(from, to),
  );
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

  // All of the shop's orders are processed per tick (fetchAllRows pages past the
  // PostgREST 1000-row cap). Orders whose resolution is identical to what is
  // already stored are skipped — so a steady-state tick issues zero writes — and
  // the rows that DID change land in set-based RPC batches, not one round-trip
  // per order (the serial loop here is what 504'd the cron in prod).
  // ship_cost_reconciled_at is informational and read nowhere; it now advances
  // only when an order's resolution actually changes.
  const changed: OrderShipCostUpdate[] = [];
  for (const o of orderRows) {
    const r = resolveOrderShipCost({
      manualOverrideCents: o.ship_cost_manual_cents ?? null,
      invoiceLineCents: invoiceByOrder.get(o.id) ?? null,
      eventParsedCents: null,
      allocatedCents: allocated?.get(o.id) ?? null,
      // Weight-based estimate (low confidence) when no manual/invoice/period
      // cost exists; null when the order has no weight, so we fall to fallback.
      modeledCents: modelOrderShipCost(
        o.grams_sum,
        zoneMultiplier(classifyZone(opts.shopCountry, o.customer_country)),
      ),
      fallbackCents: fallbackFlat,
      allocationCoverage: coverage,
    });
    if (
      r.cents === o.ship_cost_cents &&
      r.source === o.ship_cost_source &&
      r.confidence === o.ship_cost_confidence
    ) {
      continue;
    }
    changed.push({
      id: o.id,
      ship_cost_cents: r.cents,
      ship_cost_source: r.source,
      ship_cost_confidence: r.confidence,
      ship_cost_reconciled_at: nowIso,
    });
  }
  await applyInBatches(sb, "ship_cost_apply_order_updates", shopId, changed);

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
  ship_cost_cents: number | null;
  contribution_margin_cents: number | null;
}

export async function rollShipCostIntoSkuPnl(
  sb: SupabaseClient,
  shopId: string,
): Promise<void> {
  // Load orders that have a resolved ship cost
  const orderFacts = await fetchAllRows<OrderFactRow>("order_fact", (from, to) =>
    sb
      .from("order_fact")
      .select("id, created_at_source, ship_cost_cents")
      .eq("shop_id", shopId)
      .not("ship_cost_cents", "is", null)
      .range(from, to),
  );
  if (orderFacts.length === 0) return;

  // Load all order lines for the shop
  const orderLines = await fetchAllRows<OrderLineRow>("order_line_fact", (from, to) =>
    sb
      .from("order_line_fact")
      .select("id, order_id, sku_id, grams, quantity")
      .eq("shop_id", shopId)
      .range(from, to),
  );

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
  const pnlRows = await fetchAllRows<SkuPnlRow>("sku_pnl", (from, to) =>
    sb
      .from("sku_pnl")
      .select(
        "id, sku_id, day, revenue_cents, cogs_cents, ad_spend_attrib_cents, return_cents, ship_cost_cents, contribution_margin_cents",
      )
      .eq("shop_id", shopId)
      .range(from, to),
  );

  // Same write discipline as the order loop above: skip rows already carrying
  // this tick's numbers, batch the rest through one set-based RPC per RPC_BATCH.
  const changed: SkuPnlUpdate[] = [];
  for (const row of pnlRows) {
    const key = `${row.sku_id}|${row.day}`;
    const shipCostCents = shipCostBySkuDay.get(key) ?? 0;
    // A (sku, day) with no computed ship cost is skipped ONLY when it also has
    // none stored. When a previously-written cost drops back to zero (invoice
    // line unmapped, period deleted, manual override removed), the zero must be
    // written — the old unconditional `=== 0` skip left the stale cost and stale
    // margin in place forever.
    if (shipCostCents === 0 && (row.ship_cost_cents ?? 0) === 0) continue;
    const contributionMarginCents =
      row.revenue_cents -
      row.cogs_cents -
      row.ad_spend_attrib_cents -
      row.return_cents -
      shipCostCents;
    if (
      shipCostCents === row.ship_cost_cents &&
      contributionMarginCents === row.contribution_margin_cents
    ) {
      continue;
    }
    changed.push({
      id: row.id,
      ship_cost_cents: shipCostCents,
      contribution_margin_cents: contributionMarginCents,
    });
  }
  await applyInBatches(sb, "ship_cost_apply_sku_pnl_updates", shopId, changed);
}
