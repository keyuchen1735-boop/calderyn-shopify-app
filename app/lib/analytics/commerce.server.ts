// Dashboard read-model for the Analytics Performance view: sales, sessions,
// conversion and channel mix over the owned order spine (orders / order_line)
// joined with storefront_event. Service-role reads threaded by shop_id, shaped
// into DTOs — Supabase rows never leak to the client. Follows the
// order/list.server.ts + payments/summary.server.ts conventions (explicit row
// caps that degrade to a floor with a console.warn, never a failed screen).
import { getSupabase } from "~/lib/supabase.server";
import { readPaged } from "~/lib/db/read-paged.server";
import type {
  AgenticStats,
  ChannelSalesRow,
  CommerceAnalytics,
  CommerceDailyRow,
  CommerceFunnel,
  CommerceTotals,
  CommerceWindowDays,
  TopProductSalesRow,
} from "./commerce-types";

export type {
  AgenticStats,
  ChannelSalesRow,
  CommerceAnalytics,
  CommerceDailyRow,
  CommerceFunnel,
  CommerceTotals,
  CommerceWindowDays,
  TopProductSalesRow,
};

// Order states that count as a sale (order/state.ts vocabulary). `refunded`
// stays in gross (the sale happened) and is subtracted again as the refund
// line — net = gross − refunds. `partially_refunded` also stays in gross; its
// refunded portion lives in refund_fact, not on the order row, so this read
// does not net it out (previously the whole order silently vanished instead).
const SALE_STATES = ["paid", "fulfilled", "refunded", "partially_refunded"] as const;

// Caps on window reads. Far above pilot volume; if a shop ever exceeds them the
// aggregates degrade to a floor rather than failing the screen (and the warn
// below says so). At that size this belongs in a SQL aggregate.
const ORDER_ROW_CAP = 10_000;
const EVENT_ROW_CAP = 50_000;
const TOP_PRODUCTS = 5;
const IN_CHUNK = 200; // PostgREST .in() rides the query string — keep URLs bounded
const AGENTIC_QUOTE_WINDOW_MS = 30 * 86_400_000;

const WINDOWS: readonly CommerceWindowDays[] = [7, 14, 30];

/** Coerce the ?days= query param to a supported window (default 30). */
export function parseWindowDays(raw: string | null): CommerceWindowDays {
  const n = Number(raw);
  return (WINDOWS as readonly number[]).includes(n) ? (n as CommerceWindowDays) : 30;
}

/** Human label for the attribution jsonb captured at checkout — same contract
 *  as the Orders screen (order/list.server.ts); null falls back to "Direct". */
function attributionLabel(attribution: unknown): string | null {
  if (!attribution || typeof attribution !== "object") return null;
  const a = attribution as Record<string, unknown>;
  const v = a.campaign_name ?? a.channel ?? a.source ?? a.medium ?? null;
  return typeof v === "string" && v.trim() ? v : null;
}

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface OrderRow {
  id: string;
  buyer_id: string | null;
  state: string;
  total_cents: number;
  shipping_cents: number;
  tax_cents: number;
  attribution: unknown;
  channel: string;
  created_at: string;
}

interface EventRow {
  session_id: string;
  type: string;
  created_at: string;
}

async function readWindowOrders(shopId: string, sinceIso: string): Promise<OrderRow[]> {
  return readPaged<OrderRow>("orders", shopId, ORDER_ROW_CAP, (from, to) =>
    getSupabase()
      .from("orders")
      .select(
        "id, buyer_id, state, total_cents, shipping_cents, tax_cents, attribution, channel, created_at",
      )
      .eq("shop_id", shopId)
      .in("state", [...SALE_STATES])
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .range(from, to),
  );
}

async function readWindowEvents(shopId: string, sinceIso: string): Promise<EventRow[]> {
  return readPaged<EventRow>("storefront_event", shopId, EVENT_ROW_CAP, (from, to) =>
    getSupabase()
      .from("storefront_event")
      .select("session_id, type, created_at")
      .eq("shop_id", shopId)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .range(from, to),
  );
}

/** Top products by line revenue (title_snapshot × unit_price_cents × quantity)
 *  across the window's sale orders, read in bounded id chunks. */
async function topProductsForOrders(
  shopId: string,
  orderIds: string[],
): Promise<TopProductSalesRow[]> {
  const sb = getSupabase();
  const byTitle = new Map<string, number>();
  for (let i = 0; i < orderIds.length; i += IN_CHUNK) {
    const { data, error } = await sb
      .from("order_line")
      .select("title_snapshot, quantity, unit_price_cents")
      .eq("shop_id", shopId)
      .in("order_id", orderIds.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`order_line read failed: ${error.message}`);
    for (const l of data ?? []) {
      const title = String(l.title_snapshot ?? "Untitled product");
      const cents = Number(l.unit_price_cents ?? 0) * Number(l.quantity ?? 0);
      byTitle.set(title, (byTitle.get(title) ?? 0) + cents);
    }
  }
  return [...byTitle.entries()]
    .map(([title, grossCents]) => ({ title, grossCents }))
    .sort((a, b) => b.grossCents - a.grossCents)
    .slice(0, TOP_PRODUCTS);
}

/** Agentic-channel stats on the same basis as /dashboard/api/agentic:
 *  connected commerce-scope clients via non-revoked mcp_tokens, quote count
 *  (restricted here to the last 30 days to match the card's label), and
 *  channel='agentic' sales (SALE_STATES) within the selected window so the
 *  card agrees with the rest of the screen. */
async function agenticStats(shopId: string, now: Date, sinceIso: string): Promise<AgenticStats> {
  const sb = getSupabase();

  const tokensRes = await sb
    .from("mcp_tokens")
    .select("client_id")
    .eq("shop_id", shopId)
    .is("revoked_at", null);
  if (tokensRes.error) throw new Error(`mcp_tokens read failed: ${tokensRes.error.message}`);
  const clientIds = [
    ...new Set(
      (tokensRes.data ?? [])
        .map((t) => t.client_id)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];

  let connectedClients = 0;
  if (clientIds.length > 0) {
    const clientsRes = await sb
      .from("mcp_oauth_clients")
      .select("client_id", { count: "exact", head: true })
      .eq("commerce_scope", true)
      .in("client_id", clientIds);
    if (clientsRes.error) {
      throw new Error(`mcp_oauth_clients read failed: ${clientsRes.error.message}`);
    }
    connectedClients = clientsRes.count ?? 0;
  }

  const quoteSince = new Date(now.getTime() - AGENTIC_QUOTE_WINDOW_MS).toISOString();
  const quotesRes = await sb
    .from("commerce_quote_fact")
    .select("*", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .gte("created_at", quoteSince);
  if (quotesRes.error) {
    throw new Error(`commerce_quote_fact read failed: ${quotesRes.error.message}`);
  }

  const ordersRes = await sb
    .from("orders")
    .select("state, total_cents")
    .eq("shop_id", shopId)
    .eq("channel", "agentic")
    .in("state", [...SALE_STATES])
    .gte("created_at", sinceIso);
  if (ordersRes.error) throw new Error(`agentic orders read failed: ${ordersRes.error.message}`);
  const orders = ordersRes.data ?? [];

  return {
    connectedClients,
    quotes30d: quotesRes.count ?? 0,
    orders: orders.length,
    gmvCents: orders.reduce((s, o) => s + Number(o.total_cents ?? 0), 0),
  };
}

export async function loadCommerceAnalytics(
  shopId: string,
  days: CommerceWindowDays,
  now = new Date(),
): Promise<CommerceAnalytics> {
  // Window = the last `days` UTC days including today, zero-filled per day.
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1));
  const sinceIso = new Date(start).toISOString();
  const dayKeys: string[] = [];
  for (let i = 0; i < days; i++) dayKeys.push(utcDayKey(new Date(start + i * 86_400_000)));

  const [orders, events, agentic] = await Promise.all([
    readWindowOrders(shopId, sinceIso),
    readWindowEvents(shopId, sinceIso),
    agenticStats(shopId, now, sinceIso),
  ]);

  // --- per-day order aggregation ---
  const grossByDay = new Map<string, number>();
  const ordersByDay = new Map<string, number>();
  const fulfilledByDay = new Map<string, number>();
  const ordersByBuyer = new Map<string, number>();
  const byChannel = new Map<string, ChannelSalesRow>();
  let gross = 0;
  let fulfilled = 0;
  let refund = 0;
  let shipping = 0;
  let tax = 0;
  for (const o of orders) {
    const day = String(o.created_at).slice(0, 10);
    const total = Number(o.total_cents ?? 0);
    gross += total;
    shipping += Number(o.shipping_cents ?? 0);
    tax += Number(o.tax_cents ?? 0);
    grossByDay.set(day, (grossByDay.get(day) ?? 0) + total);
    ordersByDay.set(day, (ordersByDay.get(day) ?? 0) + 1);
    if (o.state === "fulfilled") {
      fulfilled += 1;
      fulfilledByDay.set(day, (fulfilledByDay.get(day) ?? 0) + 1);
    }
    if (o.state === "refunded") refund += total;
    if (o.buyer_id) {
      const key = String(o.buyer_id);
      ordersByBuyer.set(key, (ordersByBuyer.get(key) ?? 0) + 1);
    }
    // Channel mix: the agentic order channel outranks checkout attribution;
    // everything unattributed is "Direct".
    const isAgentic = String(o.channel) === "agentic";
    const label = isAgentic ? "Agentic · AI" : attributionLabel(o.attribution) ?? "Direct";
    const acc = byChannel.get(label) ?? { label, grossCents: 0, agentic: isAgentic };
    acc.grossCents += total;
    byChannel.set(label, acc);
  }

  // --- distinct-session aggregation (page views per day + funnel stages) ---
  const sessionsByDay = new Map<string, Set<string>>();
  const stageSessions: Record<string, Set<string>> = {
    page_view: new Set(),
    cart_add: new Set(),
    checkout_start: new Set(),
    checkout_complete: new Set(),
  };
  for (const e of events) {
    const sid = String(e.session_id);
    const stage = stageSessions[String(e.type)];
    if (stage) stage.add(sid);
    if (e.type !== "page_view") continue;
    const day = String(e.created_at).slice(0, 10);
    let set = sessionsByDay.get(day);
    if (!set) {
      set = new Set();
      sessionsByDay.set(day, set);
    }
    set.add(sid);
  }

  const daily: CommerceDailyRow[] = dayKeys.map((date) => {
    const sessions = sessionsByDay.get(date)?.size ?? 0;
    const dayOrders = ordersByDay.get(date) ?? 0;
    return {
      date,
      grossCents: grossByDay.get(date) ?? 0,
      orders: dayOrders,
      fulfilled: fulfilledByDay.get(date) ?? 0,
      sessions,
      conversionPct: sessions > 0 ? (dayOrders / sessions) * 100 : null,
    };
  });

  let repeatBuyers = 0;
  for (const n of ordersByBuyer.values()) if (n > 1) repeatBuyers += 1;
  const totals: CommerceTotals = {
    grossCents: gross,
    orders: orders.length,
    fulfilled,
    returningPct: ordersByBuyer.size > 0 ? (repeatBuyers / ordersByBuyer.size) * 100 : null,
    refundCents: refund,
    shippingCents: shipping,
    taxCents: tax,
    netCents: gross - refund,
  };

  const funnel: CommerceFunnel = {
    sessions: stageSessions.page_view.size,
    carts: stageSessions.cart_add.size,
    checkouts: stageSessions.checkout_start.size,
    purchases: stageSessions.checkout_complete.size,
  };

  return {
    days,
    daily,
    totals,
    byChannel: [...byChannel.values()].sort((a, b) => b.grossCents - a.grossCents),
    topProducts: await topProductsForOrders(
      shopId,
      orders.map((o) => String(o.id)),
    ),
    funnel,
    agentic,
  };
}
