// DTO shapes for the unified order-detail read model (Task 9). Plain types
// only, safe to import from the browser — no imports from .server files.
// One shape serves both native (`orders`) and imported (`imported_order`)
// orders so the detail route/screen (Tasks 10-12) never branches on source.

export interface OrderDetailLine {
  id: string;
  /** Owned variant_dim id, for the Edit-items variant picker to keep an existing line's identity
   *  when the merchant only changes its quantity. Null for an imported (Shopify-paid) line — those
   *  key off sku_dim, not an owned variant, and are read-only besides. */
  variantId: string | null;
  title: string;
  sku: string | null;
  /** Effective quantity today (snapshot minus any reductions) — what the line actually totals. */
  quantity: number;
  /** Units reduced off this line via order_line_edit; 0 for an unedited line. Additive detail
   *  alongside `quantity`, not a replacement for it. */
  reducedQuantity: number;
  unitPriceCents: number;
  fulfilledQuantity: number;
}

export interface OrderDetailFulfillment {
  id: string;
  createdAt: string;
  trackingNumber: string | null;
  carrier: string | null;
  notifiedAt: string | null;
  units: number;
}

export interface OrderTimelineEvent {
  kind: "transition" | "note" | "refund" | "fulfillment" | "edit";
  at: string;
  title: string;
  detail: string | null;
  author: string | null;
}

export interface OrderDetail {
  source: "calderyn" | "shopify";
  id: string;
  ref: string;
  createdAt: string;
  state: string;
  financialStatus: string;
  archivedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  channel: string | null;
  attribution: string | null;
  currency: string;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  refundedCents: number;
  remainingRefundableCents: number;
  buyer: { id: string; email: string } | null;
  shippingAddress: {
    name: string | null;
    line1: string;
    line2: string | null;
    city: string | null;
    region: string | null;
    postal: string | null;
    country: string;
  } | null;
  lines: OrderDetailLine[];
  fulfillments: OrderDetailFulfillment[];
  tags: string[];
  timeline: OrderTimelineEvent[];
  /** true for imported (Shopify-paid) orders — no write actions on this surface. */
  readOnly: boolean;
}
