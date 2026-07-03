// Dashboard read-model over the owned order spine (orders / cart /
// checkout_session / shipping_invoice_line). Service-role reads threaded by
// shop_id, shaped into DTOs — Supabase rows never leak to the client.
import { getSupabase } from "~/lib/supabase.server";
import { formatOrderRef } from "./checkout.server";
import type {
  OrderRow,
  DraftCartRow,
  AbandonedCheckoutRow,
  ShipChargeRow,
  OrdersPage,
} from "./list-types";

export type { OrderRow, DraftCartRow, AbandonedCheckoutRow, ShipChargeRow, OrdersPage };

const LIST_LIMIT = 100;

/** Human label for the attribution jsonb captured at checkout. */
function attributionLabel(attribution: unknown): string | null {
  if (!attribution || typeof attribution !== "object") return null;
  const a = attribution as Record<string, unknown>;
  const v = a.campaign_name ?? a.channel ?? a.source ?? a.medium ?? null;
  return typeof v === "string" && v.trim() ? v : null;
}

async function buyerEmails(
  shopId: string,
  buyerIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(buyerIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const { data, error } = await getSupabase()
    .from("buyer_dim")
    .select("id, email_normalized")
    .eq("shop_id", shopId)
    .in("id", ids);
  if (error) throw new Error(`buyer_dim read failed: ${error.message}`);
  return new Map(
    (data ?? []).map((b) => [String(b.id), String(b.email_normalized ?? "")]),
  );
}

/** Checkouts older than this that never reached payment count as abandoned. */
const ABANDON_AFTER_MS = 60 * 60 * 1000;

export async function listOrders(shopId: string): Promise<OrderRow[]> {
  const sb = getSupabase();
  const cutoff = new Date(Date.now() - ABANDON_AFTER_MS).toISOString();
  // Stalled checkouts (checkout_pending past the cutoff) live on the Abandoned
  // tab — keeping them here would double-count never-paid checkouts as orders.
  const { data, error } = await sb
    .from("orders")
    .select(
      "id, buyer_id, state, financial_status, total_cents, currency, attribution, created_at",
    )
    .eq("shop_id", shopId)
    .or(`state.neq.checkout_pending,created_at.gte.${cutoff}`)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw new Error(`orders read failed: ${error.message}`);
  const rows = data ?? [];

  const orderIds = rows.map((r) => String(r.id));
  // Both follow-ups depend only on the rows already fetched — run them together.
  const [lineCounts, emails] = await Promise.all([
    (async () => {
      const counts = new Map<string, number>();
      if (orderIds.length === 0) return counts;
      const { data: lines, error: lineErr } = await sb
        .from("order_line")
        .select("order_id, quantity")
        .eq("shop_id", shopId)
        .in("order_id", orderIds);
      if (lineErr) throw new Error(`order_line read failed: ${lineErr.message}`);
      for (const l of lines ?? []) {
        const key = String(l.order_id);
        counts.set(key, (counts.get(key) ?? 0) + Number(l.quantity ?? 0));
      }
      return counts;
    })(),
    buyerEmails(
      shopId,
      rows.map((r) => String(r.buyer_id ?? "")),
    ),
  ]);

  return rows.map((r) => ({
    id: String(r.id),
    ref: formatOrderRef(String(r.id)),
    buyerEmail: emails.get(String(r.buyer_id)) ?? null,
    itemCount: lineCounts.get(String(r.id)) ?? 0,
    totalCents: Number(r.total_cents ?? 0),
    currency: String(r.currency ?? "usd"),
    attribution: attributionLabel(r.attribution),
    state: String(r.state),
    financialStatus: String(r.financial_status ?? "pending"),
    createdAt: String(r.created_at),
  }));
}

/** Open baskets: carts still in `cart` state that have at least one line. */
export async function listDraftCarts(shopId: string): Promise<DraftCartRow[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("cart")
    .select("id, buyer_id, created_at, cart_line(quantity, unit_price_cents)")
    .eq("shop_id", shopId)
    .eq("state", "cart")
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw new Error(`cart read failed: ${error.message}`);
  const rows = (data ?? []).filter(
    (c) => Array.isArray(c.cart_line) && c.cart_line.length > 0,
  );
  const emails = await buyerEmails(
    shopId,
    rows.map((r) => String(r.buyer_id ?? "")),
  );
  return rows.map((c) => {
    const lines = (c.cart_line ?? []) as { quantity: number; unit_price_cents: number }[];
    return {
      id: String(c.id),
      ref: formatOrderRef(String(c.id)),
      buyerEmail: c.buyer_id ? (emails.get(String(c.buyer_id)) ?? null) : null,
      itemCount: lines.reduce((a, l) => a + Number(l.quantity ?? 0), 0),
      valueCents: lines.reduce(
        (a, l) => a + Number(l.quantity ?? 0) * Number(l.unit_price_cents ?? 0),
        0,
      ),
      createdAt: String(c.created_at),
    };
  });
}

/** Checkouts that stalled: orders born at checkout (createCheckout writes the
 *  `orders` row directly — checkout_session is not part of the live spine)
 *  still `checkout_pending` after an hour, i.e. the buyer never paid. */
export async function listAbandonedCheckouts(
  shopId: string,
): Promise<AbandonedCheckoutRow[]> {
  const cutoff = new Date(Date.now() - ABANDON_AFTER_MS).toISOString();
  const { data, error } = await getSupabase()
    .from("orders")
    .select("id, buyer_id, total_cents, created_at")
    .eq("shop_id", shopId)
    .eq("state", "checkout_pending")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw new Error(`abandoned orders read failed: ${error.message}`);
  const rows = data ?? [];
  const emails = await buyerEmails(
    shopId,
    rows.map((r) => String(r.buyer_id ?? "")),
  );
  return rows.map((s) => ({
    id: String(s.id),
    ref: formatOrderRef(String(s.id)),
    buyerEmail: emails.get(String(s.buyer_id)) ?? null,
    totalCents: Number(s.total_cents ?? 0),
    createdAt: String(s.created_at),
  }));
}

/** Carrier-invoice charges (true-ship-cost lines) — the shipping paper trail. */
export async function listShipCharges(shopId: string): Promise<ShipChargeRow[]> {
  const { data, error } = await getSupabase()
    .from("shipping_invoice_line")
    .select(
      "order_ref, tracking_no, cost_cents, matched_order_id, created_at, shipping_cost_period(carrier)",
    )
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw new Error(`shipping_invoice_line read failed: ${error.message}`);
  return (data ?? []).map((l) => {
    const period = l.shipping_cost_period as { carrier: string | null } | { carrier: string | null }[] | null;
    const carrier = Array.isArray(period) ? (period[0]?.carrier ?? null) : (period?.carrier ?? null);
    return {
      orderRef: String(l.order_ref ?? "—"),
      carrier,
      tracking: l.tracking_no ? String(l.tracking_no) : null,
      costCents: Number(l.cost_cents ?? 0),
      matched: Boolean(l.matched_order_id),
      createdAt: String(l.created_at),
    };
  });
}

export async function loadOrdersPage(shopId: string): Promise<OrdersPage> {
  const [orders, drafts, abandoned, shipCharges] = await Promise.all([
    listOrders(shopId),
    listDraftCarts(shopId),
    listAbandonedCheckouts(shopId),
    listShipCharges(shopId),
  ]);
  return { orders, drafts, abandoned, shipCharges };
}
