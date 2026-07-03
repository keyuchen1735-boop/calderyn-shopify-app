// Order state machine (platform pivot #2a) — the single source of truth for which
// order-lifecycle transitions are legal. Pure (no DB, no imports) so it is trivially
// unit-testable and can be shared by any layer. transitionOrder() in order.server.ts
// is the audited DB enforcer that calls assertLegalTransition() before writing.
//
// The vocabulary mirrors the `state` check constraint in 20260629110000_order_spine.sql.

export const ORDER_STATES = [
  "cart",
  "checkout_pending",
  "paid",
  "fulfilled",
  "cancelled",
  "refunded",
  "partially_refunded",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

// Adjacency list of LEGAL forward transitions. Anything not listed is illegal —
// including backward moves (paid->cart), skips (cart->paid), and any move out of a
// terminal state (cancelled / refunded are terminal). Keyed exhaustively over
// OrderState so adding a state forces a decision here (TS Record completeness).
//
// `cart` is the shared cart-lifecycle state, NOT a live state an `orders` row ever
// occupies: an order is BORN at `checkout_pending` (see orders.state default) and never
// sits in `cart`. So `cart` only has the cart->checkout_pending edge here; a `cart ->
// cancelled` edge (cancelling an abandoned basket) is intentionally omitted because it is
// unreachable for the order state machine this enforcer guards.
//
// Refund edges (#3b): a partial Stripe refund moves paid/fulfilled -> `partially_refunded`;
// a full refund (or a later partial that reaches the captured total) moves paid / fulfilled /
// partially_refunded -> `refunded`. A SECOND partial refund on an already-partially_refunded
// order does NOT re-transition (identity moves are illegal); the refund executor detects that
// the target equals the current state and skips transitionOrder, recording only the ledger +
// refund_fact. `refunded` stays terminal. `partially_refunded -> fulfilled` is intentionally
// omitted (a refunded order is not re-fulfilled through this spine).
export const LEGAL_TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  cart: ["checkout_pending"],
  checkout_pending: ["paid", "cancelled"],
  paid: ["fulfilled", "refunded", "partially_refunded"],
  fulfilled: ["refunded", "partially_refunded"],
  partially_refunded: ["refunded"],
  cancelled: [],
  refunded: [],
};

export function isOrderState(value: string): value is OrderState {
  return (ORDER_STATES as readonly string[]).includes(value);
}

/** True iff `from -> to` is a legal transition. Identity moves (from === to) are NOT legal. */
export function isLegalTransition(from: OrderState, to: OrderState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * Throw a visible error (rule 12) unless `from -> to` is legal. Used as a guard at the
 * boundary of every state change so an illegal transition fails loudly, never silently
 * no-ops. Validates that both states are in the known vocabulary first.
 */
export function assertLegalTransition(from: string, to: string): asserts to is OrderState {
  if (!isOrderState(from)) {
    throw new Error(`unknown current order state: ${from}`);
  }
  if (!isOrderState(to)) {
    throw new Error(`unknown target order state: ${to}`);
  }
  if (!isLegalTransition(from, to)) {
    const allowed = LEGAL_TRANSITIONS[from];
    const allowedText = allowed.length ? allowed.join(", ") : "(none — terminal state)";
    throw new Error(`illegal order transition ${from} -> ${to}; allowed from ${from}: ${allowedText}`);
  }
}
