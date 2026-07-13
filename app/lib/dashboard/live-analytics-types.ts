// app/lib/dashboard/live-analytics-types.ts
// Shared DTO for the Analytics Live subtab, imported by both the server
// snapshot builder (live-analytics.server.ts) and the browser client
// (client.ts / AnalyticsLive.tsx) so the two sides cannot drift.
export interface LiveAnalyticsSnapshot {
  generated_at: string;
  visitors_now: number;
  sessions_today: number;
  total_sales_today_cents: number;
  currency: string;
  orders_today: number;
  funnel: { cart_sessions: number; checkout_sessions: number; purchased_sessions: number };
  by_location: Array<{ country: string; sessions: number }>;
  new_vs_returning: { new: number; returning: number };
  top_products: Array<{ product_id: string; title: string; sales_cents: number; units: number }>;
  /** Per-hour buckets since the store-local midnight; index 0 = the midnight
   *  hour, last index = the in-progress hour (minimum two buckets so a
   *  sparkline is drawable just after midnight). Aggregated from the same
   *  orders/events as the totals above, so a strip that pairs a "today"
   *  number with one of these series never contradicts itself. */
  hourly: {
    sales_cents: number[];
    orders: number[];
    sessions: number[];
    /** orders ÷ active sessions per hour (0 when the hour had no sessions) —
     *  a deliberate simplification of the funnel's session-based conversion,
     *  only ever consumed as a trend shape. */
    conversion_pct: number[];
  };
}
