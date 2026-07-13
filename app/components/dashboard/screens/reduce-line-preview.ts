// Pure client-side mirror of executeReduceLineAction's refund math (app/lib/order/edit.server.ts)
// so ReduceLineModal can show an honest "Refund {money}" preview BEFORE the merchant confirms,
// without a round trip. Framework-free, same pattern as order-status.ts / campaign-creative-status.ts.
//
// Server formula (edit.server.ts): deltaSubtotal = delta * unitPriceCents; taxShare =
// floor(order.taxCents * deltaSubtotal / order.subtotalCents), floored the same way Stripe/most tax
// engines round down on a partial adjustment; refundCents = deltaSubtotal + taxShare. Kept in exact
// lockstep with the server so the modal's preview number never drifts from what actually gets
// refunded.

export interface ReduceLinePreviewInput {
  unitPriceCents: number;
  /** The line's current effective quantity (OrderDetailLine.quantity). */
  currentQuantity: number;
  /** The quantity the merchant is reducing to. */
  newQuantity: number;
  /** The order's captured subtotal_cents (OrderDetail.subtotalCents) — the tax-share denominator. */
  orderSubtotalCents: number;
  /** The order's captured tax_cents (OrderDetail.taxCents). */
  orderTaxCents: number;
}

export interface ReduceLinePreview {
  deltaQuantity: number;
  deltaSubtotalCents: number;
  taxShareCents: number;
  refundCents: number;
}

export function reduceLineRefundPreview(input: ReduceLinePreviewInput): ReduceLinePreview {
  const deltaQuantity = Math.max(0, input.currentQuantity - input.newQuantity);
  const deltaSubtotalCents = deltaQuantity * input.unitPriceCents;
  const taxShareCents =
    input.orderSubtotalCents > 0 ? Math.floor((input.orderTaxCents * deltaSubtotalCents) / input.orderSubtotalCents) : 0;
  // Same defensive clamp as the server: never preview LESS than the bare unit-price delta.
  const refundCents = Math.max(deltaSubtotalCents + taxShareCents, deltaSubtotalCents);
  return { deltaQuantity, deltaSubtotalCents, taxShareCents, refundCents };
}
