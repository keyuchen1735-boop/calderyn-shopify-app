// Unmatched carrier-charge reader (Phase 3 Part C, contract C4.6 / §5 #2). The landing
// pipeline (adapters/land.server.ts) inserts charges that matched NO order with
// matched_order_id = NULL — never dropping them (rule 12) — under the synthetic
// source='connector' period. This reader surfaces those rows as a merchant-facing
// count + list on BOTH surfaces (embedded interactive; dashboard read-only). It is
// READ-ONLY and runs under the service-role key (shipping_invoice_line is deny-by-default
// RLS — keep it that way; no merchant RLS policy is added).
//
// The dashboard re-implements this SAME contract against its own postgres/withShopContext
// stack (it does not import this file) — match the contract, not the code (§7).

import type { SupabaseClient } from "@supabase/supabase-js";
import { normOrder } from "./match";

/** Why a landed charge didn't match an order — surfaced so nothing is a silent gap (rule 12). */
export type UnmatchedReason = "no_ref" | "no_tracking_match" | "carrier_adjustment_no_link";

export interface UnmatchedChargeItem {
  /** shipping_invoice_line.id */
  id: string;
  /** Provider, derived from the synthetic period's carrier (source='connector'). */
  provider: string | null;
  /** The unmatched provider order ref we couldn't resolve, if any. */
  orderRef: string | null;
  trackingNo: string | null;
  costCents: number;
  /** The provider's stable charge id (external_charge_id), if present. */
  externalChargeId: string | null;
  reason: UnmatchedReason;
}

export interface UnmatchedCharges {
  count: number;
  items: UnmatchedChargeItem[];
}

interface InvoiceLineRow {
  id: string;
  order_ref: string | null;
  tracking_no: string | null;
  cost_cents: number | null;
  external_charge_id: string | null;
  period_id: string | null;
}

/**
 * Classify why a charge stayed unmatched, from the data on the row alone (the reason is
 * DERIVED, not stored — §6 keeps it out of the schema):
 *   - no order ref AND no tracking  → it carried nothing to match on (no_ref).
 *   - had a ref/tracking but matched nothing → the key didn't line up (no_tracking_match).
 * The carrier_adjustment_no_link reason is reserved for Part A's degraded branch (a future
 * adjustment row that carries neither id nor tracking); the poll path doesn't emit it yet,
 * so it's defined but not produced here — documented, not faked (rule 12).
 */
export function classifyUnmatched(row: {
  order_ref: string | null;
  tracking_no: string | null;
}): UnmatchedReason {
  const hasRef = !!row.order_ref?.trim();
  const hasTracking = !!row.tracking_no?.trim();
  if (!hasRef && !hasTracking) return "no_ref";
  return "no_tracking_match";
}

/**
 * Read the shop's unmatched connector charges. Joins each unmatched line to its synthetic
 * period to recover the provider (period.carrier). Bounded by `limit` (default 200) so a
 * pathological shop can't return an unbounded list to the UI; `count` is the true total.
 */
export async function getUnmatchedCharges(
  sb: SupabaseClient,
  shopId: string,
  limit = 200,
): Promise<UnmatchedCharges> {
  // The CONNECTOR periods for this shop (source='connector', one per provider). We scope the
  // unmatched surface to ONLY these: the CSV-upload path also lands matched_order_id=NULL
  // rows under an 'upload' period, but those are not carrier-connector charges and must not
  // appear in (or be mappable from) the "unmatched carrier charges" surface. carrier holds
  // the provider for connector periods.
  const periodsRes = await sb
    .from("shipping_cost_period")
    .select("id, carrier")
    .eq("shop_id", shopId)
    .eq("source", "connector");
  if (periodsRes.error) throw periodsRes.error;
  const connectorPeriods = (periodsRes.data ?? []) as { id: string; carrier: string | null }[];
  const providerByPeriod = new Map<string, string | null>();
  for (const p of connectorPeriods) providerByPeriod.set(String(p.id), p.carrier);
  const connectorPeriodIds = connectorPeriods.map((p) => String(p.id));
  if (connectorPeriodIds.length === 0) return { count: 0, items: [] };

  // Unmatched lines UNDER the connector periods only. matched_order_id IS NULL is the
  // Phase-1 "surfaced, not dropped" invariant; period_id IN (connector ids) is the
  // source scope.
  const linesRes = await sb
    .from("shipping_invoice_line")
    .select("id, order_ref, tracking_no, cost_cents, external_charge_id, period_id")
    .eq("shop_id", shopId)
    .is("matched_order_id", null)
    .in("period_id", connectorPeriodIds);
  if (linesRes.error) throw linesRes.error;
  const lines = (linesRes.data ?? []) as InvoiceLineRow[];

  const items: UnmatchedChargeItem[] = lines.slice(0, limit).map((l) => ({
    id: String(l.id),
    provider: l.period_id ? providerByPeriod.get(String(l.period_id)) ?? null : null,
    orderRef: l.order_ref,
    trackingNo: l.tracking_no,
    costCents: l.cost_cents ?? 0,
    externalChargeId: l.external_charge_id,
    reason: classifyUnmatched(l),
  }));

  return { count: lines.length, items };
}

export interface MapChargeResult {
  /** True when the order resolved and the line was attached. */
  ok: boolean;
  /** The order_fact.id the charge was attached to. */
  orderId: string;
}

/**
 * Attach an unmatched charge to an order by order NUMBER (the merchant types it). Validates
 * the order belongs to the shop (fail visibly on an unknown order — rule 12, no silent
 * no-op), then sets matched_order_id on the line. The caller re-runs runShipCostResolution
 * so the order flips to actual_invoice and the unmatched count decrements.
 *
 * Pre-aggregation note (C4.3): the runner's source-priority map (runner.server.ts) already
 * collapses multiple lines per order deterministically, so mapping a charge onto an order
 * that already has a line is safe — the resolver picks the highest-precedence line, it does
 * not sum two rows here. (The connector's own landing pre-aggregates within a pull; this
 * manual attach is a single row.) Throws on a DB error rather than reporting a false success.
 */
export async function mapChargeToOrder(
  sb: SupabaseClient,
  shopId: string,
  lineId: string,
  orderNumber: string,
): Promise<MapChargeResult> {
  const wanted = normOrder(orderNumber);
  if (!wanted) throw new Error("Enter an order number.");

  // Restrict the attach to CONNECTOR-source lines (same scope as the reader): an unmatched
  // 'upload'/'typed' line is not a carrier charge and must not be mappable from this surface.
  const periodsRes = await sb
    .from("shipping_cost_period")
    .select("id")
    .eq("shop_id", shopId)
    .eq("source", "connector");
  if (periodsRes.error) throw periodsRes.error;
  const connectorPeriodIds = ((periodsRes.data ?? []) as { id: string }[]).map((p) => String(p.id));
  if (connectorPeriodIds.length === 0) {
    throw new Error("That charge is no longer available to map.");
  }

  // Resolve order_number → order_fact.id for THIS shop. order_number is stored with the
  // shop's own formatting; normalize both sides the same way matchInvoiceLines does (normOrder).
  const ordersRes = await sb
    .from("order_fact")
    .select("id, order_number")
    .eq("shop_id", shopId);
  if (ordersRes.error) throw ordersRes.error;
  const match = ((ordersRes.data ?? []) as { id: string; order_number: string | null }[]).find(
    (o) => normOrder(String(o.order_number ?? "")) === wanted,
  );
  if (!match) {
    // Visible failure — the merchant typed an order we don't have for this shop.
    throw new Error(`No order ${orderNumber} found for this shop.`);
  }

  // Attach only if the line is currently unmatched, belongs to the shop, AND is a connector
  // line — guards against mapping an already-resolved line, a cross-shop id, or a CSV line.
  // .select() returns the affected rows so we can detect a no-op (0 rows) and fail visibly
  // (rule 12) instead of reporting a false success on a stale/already-mapped/wrong-source id.
  const upd = await sb
    .from("shipping_invoice_line")
    .update({ matched_order_id: match.id })
    .eq("id", lineId)
    .eq("shop_id", shopId)
    .is("matched_order_id", null)
    .in("period_id", connectorPeriodIds)
    .select("id");
  if (upd.error) throw upd.error;
  const affected = (upd.data ?? []) as { id: string }[];
  if (affected.length === 0) {
    // Nothing changed: the line was already mapped, doesn't belong to this shop, or isn't a
    // connector charge. Surface it rather than redirecting to a success the merchant can't see.
    throw new Error("That charge couldn't be mapped — it may already be resolved.");
  }

  return { ok: true, orderId: match.id };
}
