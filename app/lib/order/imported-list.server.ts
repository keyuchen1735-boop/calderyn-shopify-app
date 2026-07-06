// Read model over the imported (historical, Shopify-origin) order tables
// (imported_order / imported_refund). These are the read-only analytics-
// continuity records the Import-from-Shopify promote lands; they are NOT the
// native `orders` checkout spine and carry no Calderyn payment, so this surface
// is view-only (a refund on an order paid on Shopify is refused by
// refund.server.ts — Calderyn cannot reverse a charge it never made).
//
// Service-role reads threaded by shop_id, shaped into DTOs; paginated over the
// PostgREST 1000-row clamp (a 12-month import is thousands of rows).
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "~/lib/supabase.server";
import type {
  ImportedOrderRow,
  ImportedOrdersPage,
  ImportedOrdersSummary,
} from "./imported-list-types";

export type { ImportedOrderRow, ImportedOrdersPage, ImportedOrdersSummary };

/** Rows past this are summary-only: the table shows the most recent slice, while
 *  the summary still covers every imported order. */
const RECENT_LIMIT = 500;
/** PostgREST hard-caps a response at 1000 rows regardless of .range(); page under it. */
const PAGE = 1000;

// Minimal raw shapes (only the columns the DTO needs).
export interface RawImportedOrder {
  id: string;
  order_number: string | null;
  external_id: string;
  financial_status: string | null;
  currency: string | null;
  total_cents: number | null;
  processed_at: string | null;
}
export interface RawImportedRefund {
  imported_order_id: string | null;
  subtotal_cents: number | null;
}

/** "#13785" when order_number is present, else a short "#<tail>" of the GID. */
function orderRef(order_number: string | null, external_id: string): string {
  const n = order_number?.trim();
  if (n) return n.startsWith("#") ? n : `#${n}`;
  const tail = external_id.split("/").pop() || external_id;
  return `#${tail}`;
}

/** Epoch ms for a timestamp, or null when absent/unparseable. */
function parseMs(v: string | null): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Pure: fold raw imported orders + refunds into the merchant-facing page. The
 * summary spans ALL orders; `orders` is the most-recent `recentLimit` slice so a
 * multi-thousand-row import never ships wholesale to the browser.
 */
export function buildImportedOrdersPage(
  orders: RawImportedOrder[],
  refunds: RawImportedRefund[],
  recentLimit: number,
): ImportedOrdersPage {
  // Only refunds tied to an imported order feed the summary, so Gross, Refunded,
  // and Net share one population and `Net = Gross - Refunded` always holds. An
  // orphan refund (imported_order_id null) belongs to an order that fell outside
  // the imported window and is not shown here; folding it into Refunded would
  // subtract from a Gross that never counted its sale (understating Net).
  const refundedByOrder = new Map<string, number>();
  let refundedTotal = 0;
  let refundCount = 0;
  for (const r of refunds) {
    if (!r.imported_order_id) continue;
    const key = String(r.imported_order_id);
    const cents = Number(r.subtotal_cents ?? 0);
    refundedTotal += cents;
    refundCount += 1;
    refundedByOrder.set(key, (refundedByOrder.get(key) ?? 0) + cents);
  }

  let grossCents = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  let currency = "";
  for (const o of orders) {
    grossCents += Number(o.total_cents ?? 0);
    if (!currency && o.currency) currency = String(o.currency).toUpperCase();
    const ms = parseMs(o.processed_at);
    if (ms != null) {
      if (firstMs == null || ms < firstMs) firstMs = ms;
      if (lastMs == null || ms > lastMs) lastMs = ms;
    }
  }

  const summary: ImportedOrdersSummary = {
    orderCount: orders.length,
    grossCents,
    refundedCents: refundedTotal,
    refundCount,
    netCents: grossCents - refundedTotal,
    currency: currency || "USD",
    firstOrderAt: firstMs == null ? null : new Date(firstMs).toISOString(),
    lastOrderAt: lastMs == null ? null : new Date(lastMs).toISOString(),
  };

  // Most-recent first; rows with no processed_at sort last.
  const sorted = [...orders].sort((a, b) => {
    const am = parseMs(a.processed_at);
    const bm = parseMs(b.processed_at);
    if (am == null && bm == null) return 0;
    if (am == null) return 1;
    if (bm == null) return -1;
    return bm - am;
  });

  const rows: ImportedOrderRow[] = sorted
    .slice(0, Math.max(0, recentLimit))
    .map((o) => ({
      id: String(o.id),
      ref: orderRef(o.order_number, o.external_id),
      financialStatus: String(o.financial_status ?? "").toLowerCase(),
      totalCents: Number(o.total_cents ?? 0),
      refundedCents: refundedByOrder.get(String(o.id)) ?? 0,
      currency: (o.currency ? String(o.currency) : summary.currency).toUpperCase(),
      processedAt: o.processed_at,
    }));

  return { summary, orders: rows, totalCount: orders.length, shownCount: rows.length };
}

/** Page every imported_order row for a shop (ordered newest-first, id tiebreak
 *  so pagination is stable across the 1000-row boundary). */
async function fetchAllImportedOrders(
  sb: SupabaseClient,
  shopId: string,
): Promise<RawImportedOrder[]> {
  const rows: RawImportedOrder[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("imported_order")
      .select("id, order_number, external_id, financial_status, currency, total_cents, processed_at")
      .eq("shop_id", shopId)
      .order("processed_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`imported_order read failed: ${error.message}`);
    const batch = (data ?? []) as RawImportedOrder[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

/** Page every imported_refund row for a shop (id-ordered for stable paging). */
async function fetchAllImportedRefunds(
  sb: SupabaseClient,
  shopId: string,
): Promise<RawImportedRefund[]> {
  const rows: RawImportedRefund[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("imported_refund")
      .select("imported_order_id, subtotal_cents")
      .eq("shop_id", shopId)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`imported_refund read failed: ${error.message}`);
    const batch = (data ?? []) as RawImportedRefund[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

/** Assemble the imported-orders page for the dashboard Orders "Imported" subtab. */
export async function loadImportedOrdersPage(shopId: string): Promise<ImportedOrdersPage> {
  const sb = getSupabase();
  const [orders, refunds] = await Promise.all([
    fetchAllImportedOrders(sb, shopId),
    fetchAllImportedRefunds(sb, shopId),
  ]);
  return buildImportedOrdersPage(orders, refunds, RECENT_LIMIT);
}
