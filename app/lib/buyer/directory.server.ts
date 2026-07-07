// Dashboard read-model over the owned buyer spine (buyer_dim / buyer_address /
// buyer_consent / orders / cart). Service-role reads threaded by shop_id,
// shaped into DTOs — Supabase rows never leak to the client.
import { getSupabase } from "~/lib/supabase.server";
import { formatOrderRef } from "~/lib/order/checkout.server";
import { isUuid } from "~/lib/ids";
import type {
  CustomerSegment,
  CustomerStats,
  CustomerRow,
  SegmentDef,
  CustomersPage,
  CustomerAddress,
  CustomerConsent,
  CustomerOrderRow,
  CustomerCart,
  CustomerDetail,
} from "./directory-types";

export type {
  CustomerSegment,
  CustomerStats,
  CustomerRow,
  SegmentDef,
  CustomersPage,
  CustomerAddress,
  CustomerConsent,
  CustomerOrderRow,
  CustomerCart,
  CustomerDetail,
};

// Pilot-scale caps: the directory lists the 200 most-recent buyers, and the
// purchase aggregates behind segments/stats read the 2000 most-recent orders.
const LIST_LIMIT = 200;
const ORDER_WINDOW = 2000;
const CONSENT_WINDOW = 5000;

// Order states that count as a completed purchase (a refund was still a sale). `partially_refunded`
// is included on the SAME basis as `refunded` (mirrors analytics/commerce.server SALE_STATES) —
// omitting it made a buyer whose only order was partially refunded show orders:0, spentCents:0,
// segment 'Prospect', a strict inversion of a FULLY-refunded order counting full spend.
const PURCHASE_STATES = ["paid", "fulfilled", "refunded", "partially_refunded"];
/** Real orders shown on the detail timeline — everything past checkout. */
const DISPLAY_STATES = ["paid", "fulfilled", "cancelled", "refunded", "partially_refunded"];

const VIP_SPEND_CENTS = 500_000; // > $5,000 lifetime spend
const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_WINDOW_MS = 30 * DAY_MS;
const AT_RISK_WINDOW_MS = 90 * DAY_MS;

interface BuyerAgg {
  orders: number;
  spentCents: number;
  firstOrderMs: number;
  lastOrderMs: number;
  lastOrderAt: string | null;
}

/** One segment per buyer, priority VIP > At risk > Repeat > New > One-time. */
function segmentFor(agg: BuyerAgg | null, now: number): CustomerSegment {
  if (!agg || agg.orders === 0) return "Prospect";
  if (agg.spentCents > VIP_SPEND_CENTS) return "VIP";
  if (now - agg.lastOrderMs > AT_RISK_WINDOW_MS) return "At risk";
  if (agg.orders > 1) return "Repeat";
  if (now - agg.firstOrderMs <= NEW_WINDOW_MS) return "New";
  return "One-time";
}

function share(count: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((count / total) * 100)}%`;
}

/** Fold one purchase row into a buyer's running aggregate. */
function foldPurchase(
  map: Map<string, BuyerAgg>,
  buyerId: string,
  totalCents: number,
  createdAt: string,
): void {
  const ms = new Date(createdAt).getTime();
  const cur = map.get(buyerId);
  if (!cur) {
    map.set(buyerId, {
      orders: 1,
      spentCents: totalCents,
      firstOrderMs: ms,
      lastOrderMs: ms,
      lastOrderAt: createdAt,
    });
    return;
  }
  cur.orders += 1;
  cur.spentCents += totalCents;
  if (ms < cur.firstOrderMs) cur.firstOrderMs = ms;
  if (ms > cur.lastOrderMs) {
    cur.lastOrderMs = ms;
    cur.lastOrderAt = createdAt;
  }
}

/** Purchase aggregates per buyer over the most-recent order window. */
async function purchaseAggregates(shopId: string): Promise<Map<string, BuyerAgg>> {
  const { data, error } = await getSupabase()
    .from("orders")
    .select("buyer_id, total_cents, created_at")
    .eq("shop_id", shopId)
    .in("state", PURCHASE_STATES)
    .order("created_at", { ascending: false })
    .limit(ORDER_WINDOW);
  if (error) throw new Error(`orders read failed: ${error.message}`);
  if ((data ?? []).length >= ORDER_WINDOW) {
    // The aggregates feed "lifetime" copy (VIP spend, repeat rate, LTV); past
    // this window they're recent-orders approximations — surface it in logs so
    // the cap gets raised (or pushed into SQL) before it quietly misreports.
    console.warn(
      `[buyer.directory] order window capped at ${ORDER_WINDOW} for shop ${shopId}; segment/stat aggregates are windowed, not lifetime`,
    );
  }
  const map = new Map<string, BuyerAgg>();
  for (const r of data ?? []) {
    if (r.buyer_id == null) continue;
    foldPurchase(map, String(r.buyer_id), Number(r.total_cents ?? 0), String(r.created_at));
  }
  return map;
}

/** Buyers whose LATEST marketing-consent row is accepted (append-only table,
 *  so the newest row per buyer wins). */
async function marketingOptIns(shopId: string): Promise<Set<string>> {
  const { data, error } = await getSupabase()
    .from("buyer_consent")
    .select("buyer_id, accepted, captured_at")
    .eq("shop_id", shopId)
    .eq("policy", "marketing")
    .order("captured_at", { ascending: false })
    .limit(CONSENT_WINDOW);
  if (error) throw new Error(`buyer_consent read failed: ${error.message}`);
  const seen = new Set<string>();
  const optedIn = new Set<string>();
  for (const r of data ?? []) {
    const buyerId = String(r.buyer_id);
    if (seen.has(buyerId)) continue;
    seen.add(buyerId);
    if (r.accepted) optedIn.add(buyerId);
  }
  return optedIn;
}

interface AddressRank {
  city: string | null;
  country: string | null;
  score: number;
}

/** Best-address city/country per buyer: default shipping > shipping > default
 *  billing > any. */
async function buyerLocations(
  shopId: string,
  buyerIds: string[],
): Promise<Map<string, { city: string | null; country: string | null }>> {
  if (buyerIds.length === 0) return new Map();
  const { data, error } = await getSupabase()
    .from("buyer_address")
    .select("buyer_id, kind, city, country, is_default")
    .eq("shop_id", shopId)
    .in("buyer_id", buyerIds);
  if (error) throw new Error(`buyer_address read failed: ${error.message}`);
  const best = new Map<string, AddressRank>();
  for (const a of data ?? []) {
    const buyerId = String(a.buyer_id);
    const score = (a.kind === "shipping" ? 2 : 0) + (a.is_default ? 1 : 0);
    const cur = best.get(buyerId);
    if (!cur || score > cur.score) {
      best.set(buyerId, {
        city: a.city ? String(a.city) : null,
        country: a.country ? String(a.country) : null,
        score,
      });
    }
  }
  return new Map(
    [...best.entries()].map(([id, r]) => [id, { city: r.city, country: r.country }]),
  );
}

export async function loadCustomersPage(shopId: string): Promise<CustomersPage> {
  const sb = getSupabase();
  const [buyersRes, countRes, aggs, optIns] = await Promise.all([
    sb
      .from("buyer_dim")
      .select("id, email_normalized, created_at")
      .eq("shop_id", shopId)
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT),
    sb.from("buyer_dim").select("id", { count: "exact", head: true }).eq("shop_id", shopId),
    purchaseAggregates(shopId),
    marketingOptIns(shopId),
  ]);
  if (buyersRes.error) throw new Error(`buyer_dim read failed: ${buyersRes.error.message}`);
  if (countRes.error) throw new Error(`buyer_dim count failed: ${countRes.error.message}`);

  const buyers = buyersRes.data ?? [];
  const totalBuyers = countRes.count ?? buyers.length;
  const locations = await buyerLocations(
    shopId,
    buyers.map((b) => String(b.id)),
  );
  const now = Date.now();

  const customers: CustomerRow[] = buyers.map((b) => {
    const id = String(b.id);
    const agg = aggs.get(id) ?? null;
    const loc = locations.get(id);
    return {
      id,
      email: String(b.email_normalized ?? ""),
      city: loc?.city ?? null,
      country: loc?.country ?? null,
      segment: segmentFor(agg, now),
      orders: agg?.orders ?? 0,
      spentCents: agg?.spentCents ?? 0,
      lastOrderAt: agg?.lastOrderAt ?? null,
      createdAt: String(b.created_at),
    };
  });

  const withOrders = aggs.size;
  let repeat = 0;
  let vip = 0;
  let atRisk = 0;
  let totalSpendCents = 0;
  for (const agg of aggs.values()) {
    totalSpendCents += agg.spentCents;
    if (agg.orders > 1) repeat += 1;
    if (agg.spentCents > VIP_SPEND_CENTS) vip += 1;
    if (now - agg.lastOrderMs > AT_RISK_WINDOW_MS) atRisk += 1;
  }

  const stats: CustomerStats = {
    customers: totalBuyers,
    repeatRatePct: withOrders > 0 ? Math.round((repeat / withOrders) * 100) : null,
    marketingConsentPct:
      totalBuyers > 0 ? Math.round((optIns.size / totalBuyers) * 100) : null,
    blendedLtvCents: withOrders > 0 ? Math.round(totalSpendCents / withOrders) : null,
  };

  const segments: SegmentDef[] = [
    {
      key: "purchased",
      name: "Purchased at least once",
      basis: "Completed one or more orders",
      count: withOrders,
      pct: share(withOrders, totalBuyers),
    },
    {
      key: "repeat",
      name: "Repeat buyers",
      basis: "Placed more than one order",
      count: repeat,
      pct: share(repeat, totalBuyers),
    },
    {
      key: "never",
      name: "Never purchased",
      basis: "Signed up but has no completed orders",
      count: Math.max(0, totalBuyers - withOrders),
      pct: share(Math.max(0, totalBuyers - withOrders), totalBuyers),
    },
    {
      key: "vip",
      name: "VIP · spent over $5,000",
      basis: "Lifetime spend above $5,000",
      count: vip,
      pct: share(vip, totalBuyers),
    },
    {
      key: "at-risk",
      name: "At risk · no order in 90 days",
      basis: "Has purchased before, but not in the last 90 days",
      count: atRisk,
      pct: share(atRisk, totalBuyers),
    },
    {
      key: "marketing",
      name: "Marketing opt-in",
      basis: "Latest marketing consent on file is accepted",
      count: optIns.size,
      pct: share(optIns.size, totalBuyers),
    },
  ];

  // weatherSuggestions is attached by the route (a separate, unrelated read
  // model) — this loader stays scoped to the buyer directory itself.
  return { stats, customers, segments, weatherSuggestions: [] };
}

interface OrderLineRow {
  quantity: number;
  title: string;
}

function summarizeLines(lines: OrderLineRow[]): string {
  if (lines.length === 0) return "—";
  const parts = lines.map((l) => `${l.quantity}× ${l.title}`);
  if (parts.length <= 2) return parts.join(", ");
  return `${parts.slice(0, 2).join(", ")} +${parts.length - 2} more`;
}

/** Line summaries ("2× Rain Shell 2.0") keyed by order id. */
async function orderLineSummaries(
  shopId: string,
  orderIds: string[],
): Promise<Map<string, string>> {
  if (orderIds.length === 0) return new Map();
  const { data, error } = await getSupabase()
    .from("order_line")
    .select("order_id, quantity, title_snapshot")
    .eq("shop_id", shopId)
    .in("order_id", orderIds);
  if (error) throw new Error(`order_line read failed: ${error.message}`);
  const byOrder = new Map<string, OrderLineRow[]>();
  for (const l of data ?? []) {
    const key = String(l.order_id);
    const rows = byOrder.get(key) ?? [];
    rows.push({
      quantity: Number(l.quantity ?? 0),
      title: l.title_snapshot ? String(l.title_snapshot) : "Item",
    });
    byOrder.set(key, rows);
  }
  return new Map(orderIds.map((id) => [id, summarizeLines(byOrder.get(id) ?? [])]));
}

interface CartLineJoin {
  quantity: number;
  unit_price_cents: number;
  title_snapshot: string | null;
}

/** Newest open cart that actually has lines, else null. */
async function openCart(shopId: string, buyerId: string): Promise<CustomerCart | null> {
  const { data, error } = await getSupabase()
    .from("cart")
    .select("id, created_at, cart_line(quantity, unit_price_cents, title_snapshot)")
    .eq("shop_id", shopId)
    .eq("buyer_id", buyerId)
    .eq("state", "cart")
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(`cart read failed: ${error.message}`);
  for (const c of data ?? []) {
    const lines = (c.cart_line ?? []) as CartLineJoin[];
    if (lines.length === 0) continue;
    const items = lines.map((l) => ({
      title: l.title_snapshot ? String(l.title_snapshot) : "Item",
      quantity: Number(l.quantity ?? 0),
      priceCents: Number(l.unit_price_cents ?? 0),
    }));
    return {
      items,
      valueCents: items.reduce((a, i) => a + i.quantity * i.priceCents, 0),
    };
  }
  return null;
}

/** Full detail for one buyer, or null when the id isn't in this shop. */
export async function loadCustomerDetail(
  shopId: string,
  buyerId: string,
): Promise<CustomerDetail | null> {
  // A malformed id can't match a row; short-circuit so a garbage param 404s
  // instead of tripping a Postgres uuid-cast error into a 500.
  if (!isUuid(buyerId)) return null;

  const sb = getSupabase();
  const { data: buyer, error: buyerErr } = await sb
    .from("buyer_dim")
    .select("id, email_normalized, phone, created_at")
    .eq("shop_id", shopId)
    .eq("id", buyerId)
    .maybeSingle();
  if (buyerErr) throw new Error(`buyer_dim read failed: ${buyerErr.message}`);
  if (!buyer) return null;

  const [ordersRes, addrRes, consentRes, cart] = await Promise.all([
    sb
      .from("orders")
      .select("id, state, total_cents, created_at")
      .eq("shop_id", shopId)
      .eq("buyer_id", buyerId)
      .in("state", DISPLAY_STATES)
      .order("created_at", { ascending: false })
      .limit(500),
    sb
      .from("buyer_address")
      .select("kind, name, line1, line2, city, region, postal, country, is_default")
      .eq("shop_id", shopId)
      .eq("buyer_id", buyerId)
      .order("is_default", { ascending: false }),
    sb
      .from("buyer_consent")
      .select("policy, accepted, captured_at")
      .eq("shop_id", shopId)
      .eq("buyer_id", buyerId)
      .order("captured_at", { ascending: false }),
    openCart(shopId, buyerId),
  ]);
  if (ordersRes.error) throw new Error(`orders read failed: ${ordersRes.error.message}`);
  if (addrRes.error) throw new Error(`buyer_address read failed: ${addrRes.error.message}`);
  if (consentRes.error) throw new Error(`buyer_consent read failed: ${consentRes.error.message}`);

  const orderRows = ordersRes.data ?? [];

  // Aggregates + segment come from completed purchases only.
  const agg = new Map<string, BuyerAgg>();
  for (const o of orderRows) {
    if (!PURCHASE_STATES.includes(String(o.state))) continue;
    foldPurchase(agg, buyerId, Number(o.total_cents ?? 0), String(o.created_at));
  }
  const purchases = agg.get(buyerId) ?? null;
  const ordersCount = purchases?.orders ?? 0;
  const spentCents = purchases?.spentCents ?? 0;

  const display = orderRows.slice(0, 10);
  const lineSummaries = await orderLineSummaries(
    shopId,
    display.map((o) => String(o.id)),
  );
  const orders: CustomerOrderRow[] = display.map((o) => {
    const id = String(o.id);
    return {
      id,
      ref: formatOrderRef(id),
      createdAt: String(o.created_at),
      items: lineSummaries.get(id) ?? "—",
      totalCents: Number(o.total_cents ?? 0),
      state: String(o.state),
    };
  });

  const addresses: CustomerAddress[] = (addrRes.data ?? []).map((a) => ({
    kind: String(a.kind),
    name: a.name ? String(a.name) : null,
    line1: a.line1 ? String(a.line1) : null,
    line2: a.line2 ? String(a.line2) : null,
    city: a.city ? String(a.city) : null,
    region: a.region ? String(a.region) : null,
    postal: a.postal ? String(a.postal) : null,
    country: a.country ? String(a.country) : null,
    isDefault: Boolean(a.is_default),
  }));

  // Latest row per policy wins (rows arrive newest-first).
  const consents: CustomerConsent[] = [];
  const seenPolicies = new Set<string>();
  for (const c of consentRes.data ?? []) {
    const policy = String(c.policy);
    if (seenPolicies.has(policy)) continue;
    seenPolicies.add(policy);
    consents.push({
      policy,
      accepted: Boolean(c.accepted),
      capturedAt: String(c.captured_at),
    });
  }

  // Same best-address ranking as the directory list.
  const bestAddr =
    addresses.find((a) => a.kind === "shipping" && a.isDefault) ??
    addresses.find((a) => a.kind === "shipping") ??
    addresses.find((a) => a.isDefault) ??
    addresses[0] ??
    null;

  return {
    customer: {
      id: String(buyer.id),
      email: String(buyer.email_normalized ?? ""),
      phone: buyer.phone ? String(buyer.phone) : null,
      city: bestAddr?.city ?? null,
      country: bestAddr?.country ?? null,
      segment: segmentFor(purchases, Date.now()),
      since: String(buyer.created_at),
      ordersCount,
      spentCents,
      aovCents: ordersCount > 0 ? Math.round(spentCents / ordersCount) : 0,
      lastOrderAt: purchases?.lastOrderAt ?? null,
    },
    addresses,
    consents,
    orders,
    cart,
  };
}
