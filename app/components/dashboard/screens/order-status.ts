// Pure order-status helpers shared by the Orders list and the order detail screen. Kept
// framework-free (no React) so the fulfillment-badge derivation is trivially unit-testable —
// same pattern as campaign-creative-status.ts.

export interface FulfillmentBadge {
  label: string;
  tone: string;
}

/**
 * Fulfillment badge for a native order's lifecycle `state` (the OrderState enum in
 * app/lib/order/state.ts) — separate from the Payment pill, which reads `financial_status`.
 * Returns null where "fulfillment" isn't a meaningful concept (checkout_pending, cart) or where
 * the lifecycle state no longer carries fulfillment information (refunded, partially_refunded),
 * so the caller renders nothing rather than a misleading badge. Imported (Shopify-paid) orders
 * never call this: their `state` field carries a financial status, not this vocabulary.
 */
export function fulfillmentBadge(state: string, cancelledAt: string | null): FulfillmentBadge | null {
  if (cancelledAt || state === "cancelled") return { label: "Cancelled", tone: "var(--text-3)" };
  if (state === "paid") return { label: "Unfulfilled", tone: "var(--orange)" };
  if (state === "partially_fulfilled") return { label: "Partially fulfilled", tone: "var(--orange)" };
  if (state === "fulfilled") return { label: "Fulfilled", tone: "var(--green)" };
  return null;
}

/** Native order states where issuing a Calderyn refund is possible. Mirrors REFUNDABLE_STATES
 *  in app/lib/actions/refund.server.ts — kept here (not duplicated per-screen) so the Orders
 *  list and the order detail screen never drift on which states show a Refund action. */
export const REFUNDABLE_ORDER_STATES = new Set(["paid", "partially_fulfilled", "fulfilled", "partially_refunded"]);

/** Native order states a cancellation may act on. Mirrors CANCELLABLE_STATES in
 *  app/lib/order/cancel.server.ts. */
export const CANCELLABLE_ORDER_STATES = new Set(["checkout_pending", "paid", "partially_fulfilled"]);

export type PaymentPillTone = "success" | "warn" | "neutral";

// financial_status vocabulary → Payment pill. Shared by native orders (whose financialStatus
// column uses the same words) and imported Shopify orders, so the Orders list and the order
// detail screen show one continuous payment vocabulary regardless of where the order came from.
const PAYMENT_STATUS_STYLE: Record<string, { label: string; tone: PaymentPillTone }> = {
  paid: { label: "Paid", tone: "success" },
  partially_paid: { label: "Partially paid", tone: "warn" },
  partially_refunded: { label: "Partially refunded", tone: "warn" },
  refunded: { label: "Refunded", tone: "warn" },
  pending: { label: "Pending", tone: "neutral" },
  authorized: { label: "Authorized", tone: "neutral" },
  voided: { label: "Voided", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
};

/** "some_status" → "Some status" fallback title-casing for a financial_status value this
 *  vocabulary table doesn't recognize, so an unmapped status still reads as words, not a raw key. */
function statusTitle(status: string): string {
  return status ? status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ") : "Unknown";
}

/** Pill label/tone for a financial_status value (Payment pill). Pure so it's unit-testable the
 *  same way scorePillStyle (score-pill.ts) drives ScorePill. */
export function paymentPillStyle(status: string): { label: string; tone: PaymentPillTone } {
  return PAYMENT_STATUS_STYLE[status] ?? { label: statusTitle(status), tone: "neutral" };
}

export type ReturnStatusTone = "warn" | "success" | "neutral" | "critical";

// order_return.status vocabulary (returns-types.ts's OrderReturnStatus) → Returns card pill.
const RETURN_STATUS_STYLE: Record<string, { label: string; tone: ReturnStatusTone }> = {
  open: { label: "Open", tone: "warn" },
  // v1's receive flow flips straight to 'closed' (returns.server.ts); 'received' is a reserved
  // future value for an async fulfillment-style intake step — styled the same as 'closed' either way.
  received: { label: "Received", tone: "success" },
  closed: { label: "Closed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/** Pill label/tone for a return's status. Pure so it's unit-testable the same way
 *  paymentPillStyle drives the Payment pill. */
export function returnStatusPill(status: string): { label: string; tone: ReturnStatusTone } {
  return RETURN_STATUS_STYLE[status] ?? { label: statusTitle(status), tone: "neutral" };
}
