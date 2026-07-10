// app/lib/order/profit.server.ts
// Per-order profit read model (orders Phase 4, Task 3): revenue, COGS, carrier cost, an
// estimated payment-fee deduction, and margin for ONE order — native or imported
// (Shopify-paid, read-only). Mirrors detail.server.ts's sourceId prefix routing
// (`shopify:<uuid>` / `calderyn:<uuid>` / a bare uuid) so a caller hands this the exact same id
// the order-detail route already accepts, and reuses its exported prefix helpers rather than
// re-deriving the parsing.
//
// GROUND TRUTH (binding — do not re-litigate; see the Task 3 report for the full trail):
//  - Payment fees are ALWAYS the labeled 2.9% + 30c/capture ESTIMATE. No real Stripe
//    processing-fee data exists anywhere in this schema; `payment_intent.application_fee_cents`
//    is Calderyn's OWN commission, never a processor fee, and is never read here.
//  - COGS = Sum (effective qty, via effectiveLineQuantities) x order_line.unit_cost_cents_snapshot;
//    a line with a null snapshot is EXCLUDED from cogsCents and counted in costsMissing instead —
//    never fabricated as 0. Imported orders mirror this off
//    imported_order_line.unit_cost_cents_snapshot (same missing-count discipline).
//  - Carrier cost: shipping_invoice_line.matched_order_id FKs order_fact.id and is 1:many, so every
//    matched row for an order is SUMMED. A native order's order_fact row is found by
//    order_fact.order_number = the native order id — emitPaidOrder (app/lib/order/emit.server.ts)
//    writes `order_number: orderId` on that upsert (NOT just external_id), and it's the exact
//    column the ship-cost CSV matcher itself joins against in ingestInvoiceCsv
//    (app/lib/ship-cost/inputs.server.ts) to build its MatchOrder rows. An imported order's
//    order_fact row (only present if the shop is ALSO live on the webhook ETL for that historical
//    order) is found by matching `external_id`, since both imported_order and order_fact store the
//    Shopify order GID under that column. No order_fact row, or one with zero matched
//    shipping_invoice_line rows, leaves carrierCostCents null ("no carrier cost recorded") — never
//    a fabricated 0. This is a deliberate flat SUM of the raw invoice-line rows, NOT the
//    allocated/modeled `order_fact.ship_cost_cents` the ship-cost runner (runner.server.ts) also
//    maintains: that column is intentionally never null (it degrades connector -> upload -> typed
//    -> a modeled estimate), which cannot express "no real carrier invoice ever matched this
//    order" the way this profit card needs to.
//  - Revenue = total_cents - ledger refunds. Reuses remainingRefundableByOrder's transaction_ledger
//    read (list.server.ts) — the SAME cheap query loadOrderDetail's refundedCents is built from —
//    rather than loading the whole OrderDetail DTO (13 parallel reads) just for one number.
//  - A native order with ZERO capture rows AND a state that was never paid-like (not
//    paid/partially_fulfilled/fulfilled/partially_refunded/refunded — i.e. still checkout_pending,
//    or cancelled before ever capturing) never took any money at all: revenueCents/feeEstimateCents
//    are 0 and profitCents/marginPct are null, plus notCaptured: true, rather than fabricating a
//    breakdown via the one-assumed-capture floor below (that floor is for a PAID-LIKE order whose
//    capture ledger is unexpectedly empty, a data-completeness gap, not "never paid").
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "~/lib/supabase.server";
import { isImportedOrderId, stripNativeOrderPrefix } from "./detail.server";
import { remainingRefundableByOrder } from "./list.server";
import { effectiveLineQuantities } from "./line-edits.server";
import type { OrderProfit } from "./profit-types";

const SHOPIFY_PREFIX = "shopify:";

/** 2.9% of the captured amount + 30 cents per capture — the ONLY fee figure this schema can ever
 *  produce (no real processor-fee data exists). See the module header. */
const FEE_PCT = 0.029;
const FEE_FLAT_CENTS = 30;

/** Paid-like native order states (fix: never-captured orders). Zero transaction_ledger capture
 *  rows is unexpected ONLY inside these states (see summarizeCaptures's one-assumed-capture
 *  floor) — a checkout_pending invoice or an abandoned cart with zero captures never took any
 *  money at all, so nativeOrderProfit returns a distinct notCaptured shape for those instead of
 *  falling into that floor. Includes 'refunded' (unlike REFUNDABLE_ORDER_STATES/order-status.ts):
 *  a fully refunded order DID capture and pay out at some point, so it's paid-like even though
 *  nothing is refundable on it anymore. */
const PAID_LIKE_STATES: ReadonlySet<string> = new Set([
  "paid",
  "partially_fulfilled",
  "fulfilled",
  "partially_refunded",
  "refunded",
]);

/** Same 4-line extraction list.server.ts/detail.server.ts each keep privately — duplicated rather
 *  than exported/shared, per those modules' own comment: it's a pure function, and this read model
 *  should stay independent of the detail DTO's assembly. */
function attributionLabel(attribution: unknown): string | null {
  if (!attribution || typeof attribution !== "object") return null;
  const a = attribution as Record<string, unknown>;
  const v = a.campaign_name ?? a.channel ?? a.source ?? a.medium ?? null;
  return typeof v === "string" && v.trim() ? v : null;
}

interface CostLine {
  effectiveQty: number;
  unitCostCentsSnapshot: number | null;
}

/** cogsCents excludes any line with a null snapshot; costsMissing counts how many were excluded.
 *  IMPORTANT: RETURNS DO NOT REDUCE COGS in v1. A return never writes order_line_edit rows, so
 *  effectiveLineQuantities remains unchanged — the goods' cost was incurred at sale time; restocked
 *  value recovery is out of scope here. COGS = sum(effective qty × unit cost) for every line that
 *  recorded a snapshot at order time, period. */
function sumCogs(lines: CostLine[]): { cogsCents: number; costsMissing: number } {
  let cogsCents = 0;
  let costsMissing = 0;
  for (const l of lines) {
    if (l.unitCostCentsSnapshot == null) {
      costsMissing += 1;
      continue;
    }
    cogsCents += l.effectiveQty * l.unitCostCentsSnapshot;
  }
  return { cogsCents, costsMissing };
}

/** Number of transaction_ledger `capture` rows for this order, and their summed amount — the
 *  "captured revenue" the fee estimate is a percentage of. A PAID-LIKE native order with ZERO
 *  capture rows is unexpected (every Stripe-paid order records exactly one on
 *  payment_intent.succeeded, and a multi-capture invoice order — post-#400 — records more than
 *  one) but must never silently zero the fee estimate: fall back to ONE assumed capture at the
 *  order total so the estimate stays an honest approximation rather than understating fees to $0.
 *  The same one-assumed-capture floor is used outright for imported orders, which never had a
 *  Calderyn-owned capture ledger. This function is never even reached for a NOT-paid-like order
 *  with zero captures — nativeOrderProfit returns the distinct notCapturedProfit shape for that
 *  case before summarizeCaptures would otherwise fabricate a fee estimate on money never taken. */
function summarizeCaptures(
  rows: { amountCents: number }[],
  fallbackTotalCents: number,
): { captureCount: number; capturedRevenueCents: number } {
  if (rows.length === 0) {
    return { captureCount: 1, capturedRevenueCents: fallbackTotalCents };
  }
  return {
    captureCount: rows.length,
    capturedRevenueCents: rows.reduce((sum, r) => sum + r.amountCents, 0),
  };
}

/** Distinct shape for a native order with zero captures that never took any money at all (see
 *  PAID_LIKE_STATES above) — never a fabricated revenue/fee breakdown built on a capture that
 *  doesn't exist. cogsCents/carrierCostCents describe real order-line/shipping facts independent
 *  of payment, but the money fields are honestly empty rather than approximated. */
function notCapturedProfit(args: {
  cogsCents: number;
  costsMissing: number;
  carrierCostCents: number | null;
  attributionLabel: string | null;
}): OrderProfit {
  return {
    source: "calderyn",
    revenueCents: 0,
    cogsCents: args.cogsCents,
    costsMissing: args.costsMissing,
    carrierCostCents: args.carrierCostCents,
    feeEstimateCents: 0,
    profitCents: null,
    marginPct: null,
    estimated: true,
    attributionLabel: args.attributionLabel,
    notCaptured: true,
  };
}

function computeProfit(args: {
  source: "calderyn" | "shopify";
  totalCents: number;
  refundedCents: number;
  cogsCents: number;
  costsMissing: number;
  carrierCostCents: number | null;
  captureCount: number;
  capturedRevenueCents: number;
  attributionLabel: string | null;
}): OrderProfit {
  const revenueCents = Math.max(0, args.totalCents - args.refundedCents);
  const feeEstimateCents = Math.round(args.capturedRevenueCents * FEE_PCT) + args.captureCount * FEE_FLAT_CENTS;
  const carrierDeduction = args.carrierCostCents ?? 0;
  const profitCents = revenueCents - args.cogsCents - carrierDeduction - feeEstimateCents;
  const marginPct = revenueCents === 0 ? null : (profitCents / revenueCents) * 100;
  return {
    source: args.source,
    revenueCents,
    cogsCents: args.cogsCents,
    costsMissing: args.costsMissing,
    carrierCostCents: args.carrierCostCents,
    feeEstimateCents,
    profitCents,
    marginPct,
    // Always true: feeEstimateCents is always a label-only estimate today (see module header).
    estimated: true,
    attributionLabel: args.attributionLabel,
  };
}

/** Sum of shipping_invoice_line.cost_cents rows whose matched_order_id is this order_fact row.
 *  Null when there are zero matched rows — "no carrier cost recorded" — never a fabricated 0. */
async function sumMatchedShippingInvoiceLines(
  sb: SupabaseClient,
  shopId: string,
  orderFactId: string,
): Promise<number | null> {
  const { data, error } = await sb
    .from("shipping_invoice_line")
    .select("cost_cents")
    .eq("shop_id", shopId)
    .eq("matched_order_id", orderFactId);
  if (error) throw new Error(`shipping_invoice_line read failed: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return null;
  return rows.reduce((sum, r) => sum + Number(r.cost_cents ?? 0), 0);
}

async function loadCarrierCostForNativeOrder(
  sb: SupabaseClient,
  shopId: string,
  orderId: string,
): Promise<number | null> {
  const factRes = await sb.from("order_fact").select("id").eq("shop_id", shopId).eq("order_number", orderId).maybeSingle();
  if (factRes.error) throw new Error(`order_fact read failed: ${factRes.error.message}`);
  const fact = factRes.data as { id: string } | null;
  if (!fact) return null;
  return sumMatchedShippingInvoiceLines(sb, shopId, fact.id);
}

async function loadCarrierCostForImportedOrder(
  sb: SupabaseClient,
  shopId: string,
  externalId: string,
): Promise<number | null> {
  if (!externalId) return null;
  const factRes = await sb.from("order_fact").select("id").eq("shop_id", shopId).eq("external_id", externalId).maybeSingle();
  if (factRes.error) throw new Error(`order_fact read failed: ${factRes.error.message}`);
  const fact = factRes.data as { id: string } | null;
  if (!fact) return null;
  return sumMatchedShippingInvoiceLines(sb, shopId, fact.id);
}

async function loadCaptureRows(sb: SupabaseClient, shopId: string, orderId: string): Promise<{ amountCents: number }[]> {
  const { data, error } = await sb
    .from("transaction_ledger")
    .select("amount_cents")
    .eq("shop_id", shopId)
    .eq("order_ref", orderId)
    .eq("kind", "capture");
  if (error) throw new Error(`transaction_ledger read failed: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({ amountCents: Number(r.amount_cents ?? 0) }));
}

async function loadNativeCostLines(sb: SupabaseClient, shopId: string, orderId: string): Promise<CostLine[]> {
  const [linesRes, effectiveMap] = await Promise.all([
    sb.from("order_line").select("id, unit_cost_cents_snapshot").eq("shop_id", shopId).eq("order_id", orderId),
    effectiveLineQuantities(shopId, orderId, sb),
  ]);
  if (linesRes.error) throw new Error(`order_line read failed: ${linesRes.error.message}`);
  const rows = (linesRes.data ?? []) as Record<string, unknown>[];
  return rows.map((r) => {
    const id = String(r.id);
    const eff = effectiveMap.get(id);
    return {
      effectiveQty: eff ? eff.effective : 0,
      unitCostCentsSnapshot: r.unit_cost_cents_snapshot == null ? null : Number(r.unit_cost_cents_snapshot),
    };
  });
}

const NATIVE_ORDER_COLS = "id, total_cents, attribution, state";

async function nativeOrderProfit(shopId: string, orderId: string): Promise<OrderProfit | null> {
  const sb = getSupabase();
  const orderRes = await sb.from("orders").select(NATIVE_ORDER_COLS).eq("shop_id", shopId).eq("id", orderId).maybeSingle();
  if (orderRes.error) throw new Error(`orders read failed: ${orderRes.error.message}`);
  const o = orderRes.data as Record<string, unknown> | null;
  if (!o) return null;
  const totalCents = Number(o.total_cents ?? 0);
  const state = String(o.state ?? "");

  // Independent reads — none depends on another's result — run together.
  const [lines, remainingMap, captureRows, carrierCostCents] = await Promise.all([
    loadNativeCostLines(sb, shopId, orderId),
    remainingRefundableByOrder(shopId, [orderId]),
    loadCaptureRows(sb, shopId, orderId),
    loadCarrierCostForNativeOrder(sb, shopId, orderId),
  ]);

  const { cogsCents, costsMissing } = sumCogs(lines);

  // Fix: zero captures + a state that was never paid-like means this order never took any money
  // (an unpaid invoice, an abandoned checkout) — return the distinct notCaptured shape instead of
  // falling into summarizeCaptures' one-assumed-capture floor, which would fabricate a revenue/fee
  // breakdown for money that was never taken.
  if (captureRows.length === 0 && !PAID_LIKE_STATES.has(state)) {
    return notCapturedProfit({ cogsCents, costsMissing, carrierCostCents, attributionLabel: attributionLabel(o.attribution) });
  }

  // Same derivation as detail.server.ts's refundedCents: ledger truth is remaining = captured -
  // already-refunded; a native order's capture is its total_cents, so refunded = total - remaining.
  const remainingRefundableCents = remainingMap.get(orderId) ?? totalCents;
  const refundedCents = Math.max(0, totalCents - remainingRefundableCents);

  const { captureCount, capturedRevenueCents } = summarizeCaptures(captureRows, totalCents);

  return computeProfit({
    source: "calderyn",
    totalCents,
    refundedCents,
    cogsCents,
    costsMissing,
    carrierCostCents,
    captureCount,
    capturedRevenueCents,
    attributionLabel: attributionLabel(o.attribution),
  });
}

const IMPORTED_ORDER_COLS = "id, external_id, total_cents";

async function importedOrderProfit(shopId: string, importedId: string): Promise<OrderProfit | null> {
  const sb = getSupabase();
  const orderRes = await sb
    .from("imported_order")
    .select(IMPORTED_ORDER_COLS)
    .eq("shop_id", shopId)
    .eq("id", importedId)
    .maybeSingle();
  if (orderRes.error) throw new Error(`imported_order read failed: ${orderRes.error.message}`);
  const o = orderRes.data as Record<string, unknown> | null;
  if (!o) return null;
  const totalCents = Number(o.total_cents ?? 0);
  const externalId = o.external_id == null ? "" : String(o.external_id);

  const [lines, refundedCents, carrierCostCents] = await Promise.all([
    loadImportedCostLines(sb, shopId, importedId),
    loadImportedRefundedCents(sb, shopId, importedId),
    loadCarrierCostForImportedOrder(sb, shopId, externalId),
  ]);

  const { cogsCents, costsMissing } = sumCogs(lines);

  // Imported orders never went through Calderyn's own checkout/Stripe — there is no capture
  // ledger to read here. The fee estimate still applies (whatever processor the merchant used on
  // Shopify almost certainly charged a comparable per-transaction fee); one assumed capture at
  // the order total is the same honest-estimate floor summarizeCaptures falls back to above.
  return computeProfit({
    source: "shopify",
    totalCents,
    refundedCents,
    cogsCents,
    costsMissing,
    carrierCostCents,
    captureCount: 1,
    capturedRevenueCents: totalCents,
    attributionLabel: null, // Calderyn never captured attribution for a sale made on Shopify.
  });
}

async function loadImportedCostLines(
  sb: SupabaseClient,
  shopId: string,
  importedOrderId: string,
): Promise<CostLine[]> {
  const { data, error } = await sb
    .from("imported_order_line")
    .select("quantity, unit_cost_cents_snapshot")
    .eq("shop_id", shopId)
    .eq("imported_order_id", importedOrderId);
  if (error) throw new Error(`imported_order_line read failed: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    // Imported lines never go through the native order_line_edit spine — the snapshot quantity IS
    // the effective quantity (same reasoning as detail.server.ts's loadImportedLines).
    effectiveQty: Number(r.quantity ?? 0),
    unitCostCentsSnapshot: r.unit_cost_cents_snapshot == null ? null : Number(r.unit_cost_cents_snapshot),
  }));
}

async function loadImportedRefundedCents(
  sb: SupabaseClient,
  shopId: string,
  importedOrderId: string,
): Promise<number> {
  const { data, error } = await sb
    .from("imported_refund")
    .select("subtotal_cents")
    .eq("shop_id", shopId)
    .eq("imported_order_id", importedOrderId);
  if (error) throw new Error(`imported_refund read failed: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).reduce((sum, r) => sum + Number(r.subtotal_cents ?? 0), 0);
}

/**
 * Per-order profit for a single order, native or imported (Shopify-paid, read-only). Returns null
 * when no row matches (the caller's route 404s rather than this module throwing on a not-found id)
 * — same not-found contract as loadOrderDetail.
 */
export async function orderProfit(shopId: string, sourceId: string): Promise<OrderProfit | null> {
  if (!shopId) throw new Error("shopId is required");
  if (!sourceId) return null;

  if (isImportedOrderId(sourceId)) {
    const importedId = sourceId.slice(SHOPIFY_PREFIX.length);
    if (!importedId) return null;
    return importedOrderProfit(shopId, importedId);
  }
  const orderId = stripNativeOrderPrefix(sourceId);
  if (!orderId) return null;
  return nativeOrderProfit(shopId, orderId);
}
