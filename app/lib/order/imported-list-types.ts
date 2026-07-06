// DTOs for the imported (historical, Shopify-origin) order surface. Plain types
// only — safe to import from the browser. Deliberately separate from the live
// order DTOs in list-types.ts: imported orders are read-only history (paid on
// Shopify), never part of the native `orders` checkout spine.

export interface ImportedOrderRow {
  id: string;
  /** Merchant-facing order number ("#13785"), falling back to a short id. */
  ref: string;
  /** Shopify financial status, lowercased (e.g. "paid", "refunded"). */
  financialStatus: string;
  totalCents: number;
  /** Sum of imported_refund lines tied to this order (0 when none). */
  refundedCents: number;
  currency: string;
  processedAt: string | null;
}

export interface ImportedOrdersSummary {
  orderCount: number;
  grossCents: number;
  refundedCents: number;
  /** Refund lines attributable to an imported order (orphan refunds excluded). */
  refundCount: number;
  netCents: number;
  currency: string;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
}

export interface ImportedOrdersPage {
  summary: ImportedOrdersSummary;
  /** Most-recent slice for the table (see RECENT_LIMIT in the server reader). */
  orders: ImportedOrderRow[];
  /** True total imported-order count (>= orders.length). */
  totalCount: number;
  /** orders.length — how many rows the table actually shows. */
  shownCount: number;
}
