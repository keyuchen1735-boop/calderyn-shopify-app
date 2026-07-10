// DTO shapes for the unified orders list read model (native UNION imported) that
// search/filter/sort/pagination and the dashboard orders screen consume. Browser-safe:
// plain types only, no server or Supabase imports.

export interface UnifiedOrderRow {
  source: "calderyn" | "shopify";
  id: string;
  ref: string;
  buyerEmail: string | null;
  totalCents: number;
  currency: string;
  paymentStatus: string; // financial_status both sides; native fallback "pending"
  state: string; // imported rows carry financial_status here (badge convention)
  cancelledAt: string | null;
  archivedAt: string | null;
  occurredAt: string;
  itemCount: number;
  tags: string[];
  remainingRefundableCents: number; // native ledger lateral; imported 0
}

export interface UnifiedOrdersPage {
  rows: UnifiedOrderRow[];
  totalCount: number;
  offset: number;
  limit: number;
}

export interface OrdersListParams {
  search?: string;
  paymentStatus?: string[]; // e.g. ["paid","partially_refunded"]
  fulfillmentStatus?: "unfulfilled" | "partially_fulfilled" | "fulfilled";
  source?: "calderyn" | "shopify";
  dateFrom?: string;
  dateTo?: string; // ISO
  tag?: string;
  archived?: boolean; // default false = exclude archived
  sort?: "date" | "total" | "customer";
  dir?: "asc" | "desc"; // default desc
  offset?: number;
  limit?: number; // default 0 / 50
}
