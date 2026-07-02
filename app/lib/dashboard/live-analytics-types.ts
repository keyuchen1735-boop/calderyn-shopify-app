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
}
