// app/lib/dashboard/live-analytics.server.ts
// Snapshot assembly for the Analytics Live subtab (spec
// 2026-07-02-analytics-live-view-design.md). Plain PostgREST reads + JS
// aggregation, matching calderyn.server.ts convention. All counts are
// DISTINCT sessions, never raw events. "Today" = the store's local midnight
// (guardrail_config.timezone), deviating deliberately from the UTC-day budget
// convention — a live merchant-facing "today" must reset at the store's
// midnight. Same accepted DST rounding as business-hours.ts.
// Deliberate simplification: no rollup tables or SQL-side aggregation;
// revisit past ~100k events/day per shop.
import type { SupabaseClient } from "@supabase/supabase-js";
import { CalderynError } from "../calderyn.server";
import { tzOffsetHours } from "./business-hours";
import type { LiveAnalyticsSnapshot } from "./live-analytics-types";

export type { LiveAnalyticsSnapshot } from "./live-analytics-types";

const VISITORS_NOW_WINDOW_MS = 5 * 60_000;
const TOP_LOCATIONS = 8;
const TOP_PRODUCTS = 5;
const IN_CHUNK = 200; // PostgREST .in() rides the query string — keep URLs bounded
const DEFAULT_TZ = "America/New_York"; // matches rowToGuardrails default

/** Wrap upstream DB errors in the house error shape so dashboardJson emits
 *  the standard SUPABASE_ERROR code instead of a bare internal_error. */
function fail(step: string, err: { message?: string }): never {
  throw new CalderynError({
    code: "SUPABASE_ERROR",
    status: 500,
    message: `live-analytics ${step}: ${err.message ?? "unknown error"}`,
  });
}

/** UTC instant of the most recent store-local midnight (offset sampled at `now`). */
export function storeTodayStartIso(tz: string, now = new Date()): string {
  const offsetMs = tzOffsetHours(tz, now) * 3_600_000;
  const local = new Date(now.getTime() + offsetMs);
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(localMidnight - offsetMs).toISOString();
}

type EventRow = {
  session_id: string;
  is_returning: boolean;
  type: string;
  country: string | null;
  created_at: string;
};
type OrderRow = {
  id: string;
  total_cents: number;
  currency: string;
  created_at: string;
  attribution: Record<string, unknown> | null;
};
type LineRow = {
  order_id: string;
  variant_id: string;
  quantity: number;
  unit_price_cents: number;
  title_snapshot: string;
};

export async function buildLiveSnapshot(
  sb: SupabaseClient,
  shopId: string,
  now = new Date(),
): Promise<LiveAnalyticsSnapshot> {
  const tzRes = await sb
    .from("guardrail_config")
    .select("timezone")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (tzRes.error) fail("timezone read", tzRes.error);
  const tz = String((tzRes.data as { timezone?: string } | null)?.timezone ?? DEFAULT_TZ);
  const todayStart = storeTodayStartIso(tz, now);
  const nowWindowStartMs = now.getTime() - VISITORS_NOW_WINDOW_MS;

  // Hourly buckets for the Home strip sparklines. The last bucket is the
  // in-progress hour; the two-bucket floor keeps the series drawable right
  // after midnight (a one-point polyline renders as nothing). Sales buckets
  // stay gross: refund netting is a day-level subtraction with no hour to
  // attribute it to.
  const todayStartMs = Date.parse(todayStart);
  const hourCount = Math.min(
    24,
    Math.max(2, Math.floor((now.getTime() - todayStartMs) / 3_600_000) + 1),
  );
  const hourOf = (iso: string) =>
    Math.min(hourCount - 1, Math.max(0, Math.floor((Date.parse(iso) - todayStartMs) / 3_600_000)));
  const hourlySales = new Array<number>(hourCount).fill(0);
  const hourlyOrders = new Array<number>(hourCount).fill(0);
  const hourlySessions: Array<Set<string>> = Array.from({ length: hourCount }, () => new Set());

  const [eventsRes, ordersRes, refundsRes] = await Promise.all([
    sb
      .from("storefront_event")
      .select("session_id, is_returning, type, country, created_at")
      .eq("shop_id", shopId)
      .gte("created_at", todayStart),
    sb
      .from("orders")
      .select("id, total_cents, currency, created_at, attribution")
      .eq("shop_id", shopId)
      // Keep partially/fully-refunded orders in gross (the sale happened); their
      // refunded cents are netted out of total sales below via refund_fact,
      // mirroring the 30-day model's SALE_STATES semantics.
      .in("financial_status", ["paid", "partially_refunded", "refunded"])
      // Go-live 50c probe orders never count as sales — and their refunds no
      // longer emit refund_fact rows, so without this filter a refunded probe
      // would stay in gross unnetted. channel is NOT NULL (default
      // 'storefront'), so .neq drops nothing legitimate.
      .neq("channel", "test")
      .gte("created_at", todayStart)
      .order("created_at", { ascending: false }),
    // Native refunds processed today (external_id gid://calderyn/…). Migrated
    // Shopify refunds are netted elsewhere, so they are excluded here to avoid
    // double-counting. A single shop's one-day refunds are far below the
    // 1000-row clamp, so no paging is needed.
    sb
      .from("refund_fact")
      .select("subtotal_cents")
      .eq("shop_id", shopId)
      .like("external_id", "gid://calderyn/%")
      .gte("processed_at", todayStart),
  ]);
  if (eventsRes.error) fail("events read", eventsRes.error);
  if (ordersRes.error) fail("orders read", ordersRes.error);
  if (refundsRes.error) fail("refunds read", refundsRes.error);
  const events = (eventsRes.data ?? []) as EventRow[];
  const orders = (ordersRes.data ?? []) as OrderRow[];
  const refunds = (refundsRes.data ?? []) as { subtotal_cents: number | null }[];
  const todayNativeRefundCents = refunds.reduce((n, r) => n + Number(r.subtotal_cents ?? 0), 0);

  // Lines for today's paid orders, fetched in bounded id chunks.
  const lines: LineRow[] = [];
  const orderIds = orders.map((o) => String(o.id));
  for (let i = 0; i < orderIds.length; i += IN_CHUNK) {
    const linesRes = await sb
      .from("order_line")
      .select("order_id, variant_id, quantity, unit_price_cents, title_snapshot")
      .eq("shop_id", shopId)
      .in("order_id", orderIds.slice(i, i + IN_CHUNK));
    if (linesRes.error) fail("order lines read", linesRes.error);
    lines.push(...((linesRes.data ?? []) as LineRow[]));
  }

  // --- distinct-session aggregation ---
  const sessions = new Set<string>();
  const now5m = new Set<string>();
  const cartSessions = new Set<string>();
  const checkoutSessions = new Set<string>();
  // Purchased is anchored on PAID ORDERS (authoritative — the Stripe webhook
  // flips the state with no browser cookie in sight), via the live_session_id
  // stamped into orders.attribution at checkout. The confirmation-page
  // checkout_complete event is unioned in as a fallback for orders that
  // predate the stamp.
  const purchasedSessions = new Set<string>();
  const returningBySession = new Map<string, boolean>();
  const byCountry = new Map<string, Set<string>>();
  for (const e of events) {
    const sid = String(e.session_id);
    sessions.add(sid);
    hourlySessions[hourOf(e.created_at)].add(sid);
    if (Date.parse(e.created_at) >= nowWindowStartMs) now5m.add(sid);
    if (e.type === "cart_add") cartSessions.add(sid);
    else if (e.type === "checkout_start") checkoutSessions.add(sid);
    else if (e.type === "checkout_complete") purchasedSessions.add(sid);
    // The flag is frozen at session start, so first-seen wins is safe.
    if (!returningBySession.has(sid)) returningBySession.set(sid, Boolean(e.is_returning));
    const country = e.country ?? "Unknown";
    let set = byCountry.get(country);
    if (!set) {
      set = new Set();
      byCountry.set(country, set);
    }
    set.add(sid);
  }
  for (const o of orders) {
    const sid = o.attribution?.live_session_id;
    if (typeof sid === "string" && sid.length > 0) purchasedSessions.add(sid);
    const h = hourOf(o.created_at);
    hourlySales[h] += Number(o.total_cents);
    hourlyOrders[h] += 1;
  }

  const locations = [...byCountry.entries()]
    .map(([country, set]) => ({ country, sessions: set.size }))
    .sort((a, b) => b.sessions - a.sessions);
  const topLocations = locations.slice(0, TOP_LOCATIONS);
  const rest = locations.slice(TOP_LOCATIONS).reduce((n, l) => n + l.sessions, 0);
  if (rest > 0) topLocations.push({ country: "Other", sessions: rest });

  let returning = 0;
  for (const r of returningBySession.values()) if (r) returning += 1;

  const byVariant = new Map<string, { title: string; sales_cents: number; units: number }>();
  for (const l of lines) {
    let acc = byVariant.get(l.variant_id);
    if (!acc) {
      acc = { title: l.title_snapshot, sales_cents: 0, units: 0 };
      byVariant.set(l.variant_id, acc);
    }
    acc.sales_cents += Number(l.unit_price_cents) * Number(l.quantity);
    acc.units += Number(l.quantity);
  }
  const topProducts = [...byVariant.entries()]
    .map(([product_id, v]) => ({ product_id, ...v }))
    .sort((a, b) => b.sales_cents - a.sales_cents)
    .slice(0, TOP_PRODUCTS);

  return {
    generated_at: now.toISOString(),
    visitors_now: now5m.size,
    sessions_today: sessions.size,
    // Deliberate simplifications, acceptable for the single-currency pilot:
    // sales use orders.created_at (no paid-at timestamp exists), and mixed
    // currencies would be summed as-is with the most recent order's currency
    // label — revisit when a multi-currency tenant onboards.
    // Gross today minus today's native refunds. Floored at 0: a refund
    // processed today can settle a prior-day order (not in today's gross), so
    // the netting can dip below zero — a negative "Sales today" headline is
    // nonsensical to a merchant, so clamp it rather than surface it.
    total_sales_today_cents: Math.max(
      0,
      orders.reduce((n, o) => n + Number(o.total_cents), 0) - todayNativeRefundCents,
    ),
    currency: orders[0]?.currency ?? "usd",
    orders_today: orders.length,
    funnel: {
      cart_sessions: cartSessions.size,
      checkout_sessions: checkoutSessions.size,
      purchased_sessions: purchasedSessions.size,
    },
    by_location: topLocations,
    new_vs_returning: { new: returningBySession.size - returning, returning },
    top_products: topProducts,
    hourly: {
      sales_cents: hourlySales,
      orders: hourlyOrders,
      sessions: hourlySessions.map((s) => s.size),
      conversion_pct: hourlyOrders.map((n, i) => {
        const s = hourlySessions[i].size;
        return s > 0 ? Math.round((n / s) * 1000) / 10 : 0;
      }),
    },
  };
}
