// Pure return-math helpers for CreateReturnModal / OrderDetail's Returns card (orders Phase 4,
// Task 2). Framework-free, same pattern as reduce-line-preview.ts / order-status.ts, so the
// returnable-quantity and default-refund math is unit-testable without mounting React.
//
// The default-refund formula is NOT re-derived here: a return line's default refund is unit price
// x quantity + a proportional share of the order's captured tax — EXACTLY the formula
// reduceLineRefundPreview already implements for a line reduction (both derive a refund from a
// quantity delta against the order's captured subtotal/tax). Reusing it (currentQuantity=quantity,
// newQuantity=0, i.e. the "delta" is the whole returned quantity) keeps this module and
// returns.server.ts's createOrderReturn in lockstep with zero duplicated tax math, mirroring
// ReduceLineModal's own reuse of the same helper.
import type { OrderReturn } from "~/lib/order/returns-types";
import { reduceLineRefundPreview } from "./reduce-line-preview";

/** A completed return's lines count against a line's returnable quantity forever after — mirrors
 *  returns.server.ts's COMPLETED_RETURN_STATUSES exactly (a still-open or cancelled return never
 *  consumed any returnable quantity). */
const COMPLETED_RETURN_STATUSES = new Set<OrderReturn["status"]>(["received", "closed"]);

/** Units of `orderLineId` already consumed by a COMPLETED return, summed across every return on
 *  the order. */
export function returnedQuantityForLine(orderLineId: string, returns: OrderReturn[]): number {
  let total = 0;
  for (const r of returns) {
    if (!COMPLETED_RETURN_STATUSES.has(r.status)) continue;
    for (const l of r.lines) {
      if (l.orderLineId === orderLineId) total += l.quantity;
    }
  }
  return total;
}

/** Units of a line still eligible for a NEW return: fulfilled minus already-received returns.
 *  Mirrors returns.server.ts's loadFulfilledQtyByLine/loadReceivedReturnQtyByLine math exactly —
 *  never negative. */
export function returnableQuantity(
  line: { id: string; fulfilledQuantity: number },
  returns: OrderReturn[],
): number {
  return Math.max(0, line.fulfilledQuantity - returnedQuantityForLine(line.id, returns));
}

/** True when at least one order line still has returnable quantity — gates the "Create return"
 *  action alongside hasOpenReturn below. */
export function anyLineReturnable(
  lines: Array<{ id: string; fulfilledQuantity: number }>,
  returns: OrderReturn[],
): boolean {
  return lines.some((l) => returnableQuantity(l, returns) > 0);
}

/** True when the order already has an open return — createOrderReturn's one-open-return guard,
 *  mirrored client-side so "Create return" never shows when the server would 409 it anyway. */
export function hasOpenReturn(returns: OrderReturn[]): boolean {
  return returns.some((r) => r.status === "open");
}

export interface DefaultReturnRefundInput {
  unitPriceCents: number;
  /** The quantity being returned (the whole delta, not a remainder). */
  quantity: number;
  orderSubtotalCents: number;
  orderTaxCents: number;
}

/** The server-computed default refund for returning `quantity` units of a line: unit price x
 *  quantity, plus that quantity's proportional share of the order's captured tax. Editable DOWN
 *  only in the UI — this is the cap, matching createOrderReturn's refund_exceeds_default guard. */
export function defaultReturnRefundCents(input: DefaultReturnRefundInput): number {
  return reduceLineRefundPreview({
    unitPriceCents: input.unitPriceCents,
    currentQuantity: input.quantity,
    newQuantity: 0,
    orderSubtotalCents: input.orderSubtotalCents,
    orderTaxCents: input.orderTaxCents,
  }).refundCents;
}
