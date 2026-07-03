// Wire types for the commerce-analytics read model
// (GET /dashboard/api/analytics-commerce). Browser-safe: imported by both the
// server aggregation (commerce.server.ts) and the dashboard client.

export type CommerceWindowDays = 7 | 14 | 30;

/** One UTC day in the window. Days with no activity are present and zeroed so
 *  charts always span the full range. */
export interface CommerceDailyRow {
  /** "YYYY-MM-DD" (UTC day). */
  date: string;
  /** Sum of order totals for sale-state orders created that day. */
  grossCents: number;
  /** Count of sale-state orders (paid / fulfilled / refunded) created that day. */
  orders: number;
  /** Count of orders currently in state `fulfilled` created that day. */
  fulfilled: number;
  /** Distinct page_view sessions that day. */
  sessions: number;
  /** Orders per session × 100; null when the day had no sessions. */
  conversionPct: number | null;
}

export interface CommerceTotals {
  grossCents: number;
  orders: number;
  fulfilled: number;
  /** % of window buyers with more than one sale-state order; null when the
   *  window has no attributable buyers. */
  returningPct: number | null;
  /** Sum of totals for orders currently in state `refunded` (the spine's real
   *  refund signal — there is no partial-refund ledger on the order row). */
  refundCents: number;
  shippingCents: number;
  taxCents: number;
  /** grossCents − refundCents. No discounts field exists on the order spine. */
  netCents: number;
}

export interface ChannelSalesRow {
  label: string;
  grossCents: number;
  /** True for the agentic order channel (orders.channel = 'agentic'). */
  agentic: boolean;
}

export interface TopProductSalesRow {
  title: string;
  grossCents: number;
}

/** Distinct sessions in the window per funnel stage. */
export interface CommerceFunnel {
  sessions: number;
  carts: number;
  checkouts: number;
  purchases: number;
}

/** Agentic-channel stats, mirroring /dashboard/api/agentic; null = not available. */
export interface AgenticStats {
  connectedClients: number | null;
  quotes30d: number | null;
  orders: number | null;
  /** Sum of paid agentic order totals (same basis as the Agentic screen). */
  gmvCents: number | null;
}

export interface CommerceAnalytics {
  days: CommerceWindowDays;
  daily: CommerceDailyRow[];
  totals: CommerceTotals;
  byChannel: ChannelSalesRow[];
  topProducts: TopProductSalesRow[];
  funnel: CommerceFunnel;
  agentic: AgenticStats;
}
