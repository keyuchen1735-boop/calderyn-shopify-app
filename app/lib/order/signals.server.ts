// app/lib/order/signals.server.ts
// Buyer-history order signals (Phase 4 Task 4): repeat-customer + refund-risk, read-time only.
// Folds ONE buyer-scoped `orders` read and ONE batched `transaction_ledger` read in JS — mirrors
// app/lib/buyer/directory.server.ts's purchaseAggregates fold pattern (never a per-row
// correlated subquery). `list_orders_unified` is untouched; this module is orthogonal to it.
// Stuck-unfulfilled (age-derived, no query needed) lives in the pure
// app/components/dashboard/screens/order-status.ts helper instead — detail.server.ts composes
// both into the DTO's `signals` field.
//
// GROUND TRUTH (binding — see the Task 4 report):
//  - repeatCustomer = the buyer has >= 2 orders, counting the SAME PURCHASE_STATES the buyer
//    directory's "Repeat" segment counts (paid/fulfilled/refunded/partially_refunded — see
//    app/lib/buyer/directory.server.ts), excluding channel='test' go-live probe orders. A buyer
//    with five abandoned carts and one real order is NOT a repeat customer — this mirrors the
//    existing "Repeat" segment definition rather than inventing a second, inconsistent one.
//  - refundRisk = refundRatio > 30% AND buyerOrderCount >= 2, where refundRatio is CENTS-based:
//    Sum(|refund ledger amount|) / Sum(capture ledger amount), over the SAME counted-order set
//    (transaction_ledger.order_ref -> orders.id, joined by the order ids already fetched above).
//    This is money truth, not an order-count ratio — one large refund on a big order should trip
//    this before ten one-dollar refunds spread across small orders would. A buyer with zero
//    captures (e.g. only invoice orders never paid) has refundRatio 0, never a divide-by-zero.
//  - Guest orders (buyer_id null) get no buyer signals at all: repeatCustomer false,
//    buyerOrderCount 0, refundRisk false — the QUIET_BUYER_SIGNALS shape below, no query issued.
import { getSupabase } from "~/lib/supabase.server";

/** Same purchase-states definition as app/lib/buyer/directory.server.ts's PURCHASE_STATES —
 *  duplicated rather than exported/shared: it's a 4-item literal list and this module should
 *  stay independent of the buyer-directory read model's assembly (same reasoning profit.server.ts
 *  and detail.server.ts already use for their own small duplicated helpers). */
const PURCHASE_STATES = ["paid", "fulfilled", "refunded", "partially_refunded"];

const REPEAT_CUSTOMER_MIN_ORDERS = 2;
const REFUND_RISK_RATIO = 0.3;

export interface BuyerOrderSignals {
  repeatCustomer: boolean;
  buyerOrderCount: number;
  refundRisk: boolean;
}

const QUIET_BUYER_SIGNALS: BuyerOrderSignals = {
  repeatCustomer: false,
  buyerOrderCount: 0,
  refundRisk: false,
};

interface OrderRowForSignals {
  id: unknown;
  state: unknown;
  channel: unknown;
}

interface LedgerRowForSignals {
  kind: unknown;
  amount_cents: unknown;
}

/**
 * Buyer-history signals for ONE buyer: ONE `orders` read (shop + buyer scoped) folded with ONE
 * batched `transaction_ledger` read over those order ids — never a per-row correlated subquery.
 * Returns the all-quiet shape for a null/guest buyerId without issuing any query.
 */
export async function buyerOrderSignals(shopId: string, buyerId: string | null): Promise<BuyerOrderSignals> {
  if (!buyerId) return QUIET_BUYER_SIGNALS;
  const sb = getSupabase();

  const { data: orderRows, error: ordersErr } = await sb
    .from("orders")
    .select("id, state, channel")
    .eq("shop_id", shopId)
    .eq("buyer_id", buyerId);
  if (ordersErr) throw new Error(`orders read failed: ${ordersErr.message}`);

  const orderIds = ((orderRows ?? []) as OrderRowForSignals[])
    .filter((r) => PURCHASE_STATES.includes(String(r.state)) && String(r.channel ?? "") !== "test")
    .map((r) => String(r.id));

  const buyerOrderCount = orderIds.length;
  if (buyerOrderCount === 0) return QUIET_BUYER_SIGNALS;

  const { data: ledgerRows, error: ledgerErr } = await sb
    .from("transaction_ledger")
    .select("order_ref, kind, amount_cents")
    .eq("shop_id", shopId)
    .in("order_ref", orderIds)
    .in("kind", ["capture", "refund"]);
  if (ledgerErr) throw new Error(`transaction_ledger read failed: ${ledgerErr.message}`);

  let captureCents = 0;
  let refundCents = 0;
  for (const l of (ledgerRows ?? []) as LedgerRowForSignals[]) {
    const amount = Number(l.amount_cents ?? 0);
    if (l.kind === "capture") captureCents += amount;
    else if (l.kind === "refund") refundCents += Math.abs(amount);
  }
  const refundRatio = captureCents > 0 ? refundCents / captureCents : 0;

  const repeatCustomer = buyerOrderCount >= REPEAT_CUSTOMER_MIN_ORDERS;
  const refundRisk = buyerOrderCount >= REPEAT_CUSTOMER_MIN_ORDERS && refundRatio > REFUND_RISK_RATIO;

  return { repeatCustomer, buyerOrderCount, refundRisk };
}
