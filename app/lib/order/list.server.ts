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
    // Exclude go-live 50c test-probe orders (channel='test') so the merchant's Orders screen never
    // lists phantom $0.50 orders to test-probe@calderyn.internal. channel is NOT NULL (default
    // 'storefront'), so .neq legitimately drops none of the real orders.
    .neq("channel", "test")
    .or(`state.neq.checkout_pending,created_at.gte.${cutoff}`)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw new Error(`orders read failed: ${error.message}`);
  const rows = data ?? [];

  const orderIds = rows.map((r) => String(r.id));
  // All three follow-ups depend only on the rows already fetched — run them together.
  const [lineCounts, emails, remainingByOrder] = await Promise.all([
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
    remainingRefundableByOrder(shopId, orderIds),
  ]);

  return rows.map((r) => {
    const id = String(r.id);
    const totalCents = Number(r.total_cents ?? 0);
    return {
      id,
      ref: formatOrderRef(id),
      buyerEmail: emails.get(String(r.buyer_id)) ?? null,
      itemCount: lineCounts.get(id) ?? 0,
      totalCents,
      // Fall back to the gross total when the order carries no capture ledger row (e.g. a
      // non-Calderyn-charged order that never reaches the refund modal anyway).
      remainingRefundableCents: remainingByOrder.get(id) ?? totalCents,
      currency: String(r.currency ?? "usd"),
      attribution: attributionLabel(r.attribution),
      state: String(r.state),
      financialStatus: String(r.financial_status ?? "pending"),
      createdAt: String(r.created_at),
    };
  });
}

/**
 * Remaining refundable cents per order = captured − already-refunded, from the SIGNED
 * transaction_ledger (capture positive, refund negative), keyed by order_ref (the OLTP order id).
 * Only orders that carry at least one capture row appear in the map; callers fall back to the gross
 * total for the rest. Batched in one shop-scoped read over the fetched order ids.
 */
// Exported (Task 9, order-detail read model): detail.server.ts reuses this exact summing
// shape for a single order rather than re-deriving refundable totals from the ledger.
export async function remainingRefundableByOrder(
  shopId: string,
  orderIds: string[],
): Promise<Map<string, number>> {
  const remaining = new Map<string, number>();
  if (orderIds.length === 0) return remaining;
  const { data, error } = await getSupabase()
    .from("transaction_ledger")
    .select("order_ref, kind, amount_cents")
    .eq("shop_id", shopId)
    .in("order_ref", orderIds)
    .in("kind", ["capture", "refund"]);
  if (error) throw new Error(`transaction_ledger read failed: ${error.message}`);
  for (const l of data ?? []) {
    const ref = String(l.order_ref ?? "");
    if (!ref) continue;
    // capture is positive, refund negative — the running sum IS the remaining refundable amount.
    remaining.set(ref, (remaining.get(ref) ?? 0) + Number(l.amount_cents ?? 0));
  }
  // Floor at 0 so a rounding/over-refund edge never advertises a negative refundable amount.
  for (const [ref, cents] of remaining) remaining.set(ref, Math.max(0, cents));
  return remaining;
}

/** Open baskets: carts still in `cart` state that have at least one line. */
export async function listDraftCarts(shopId: string): Promise<DraftCartRow[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("cart")
    .select("id, buyer_id, created_at, origin, cart_line(quantity, unit_price_cents, currency)")
    .eq("shop_id", shopId)
    .eq("state", "cart")
    // Exclude merchant-initiated draft carts (origin='merchant_draft') from the buyer-facing Open
    // Baskets list — they aren't an abandoned buyer basket. `origin` is nullable (existing carts
    // predate the column, and every ordinary buyer cart has no origin stamped), and PostgREST's
    // `.neq("origin", "merchant_draft")` evaluates the SQL `origin <> 'merchant_draft'`, which is
    // NULL (not TRUE) for a NULL column — so a plain `.neq` would silently drop every null-origin
    // cart. The `.or()` form below matches null origin explicitly, then excludes only the literal
    // 'merchant_draft' value.
    .or("origin.is.null,origin.neq.merchant_draft")
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
    const lines = (c.cart_line ?? []) as { quantity: number; unit_price_cents: number; currency?: string }[];
    return {
      id: String(c.id),
      ref: formatOrderRef(String(c.id)),
      buyerEmail: c.buyer_id ? (emails.get(String(c.buyer_id)) ?? null) : null,
      itemCount: lines.reduce((a, l) => a + Number(l.quantity ?? 0), 0),
      valueCents: lines.reduce(
        (a, l) => a + Number(l.quantity ?? 0) * Number(l.unit_price_cents ?? 0),
        0,
      ),
      currency: String(lines[0]?.currency ?? "usd"),
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
    .select("id, buyer_id, total_cents, currency, created_at, recovery_email_sent_at")
    .eq("shop_id", shopId)
    .eq("state", "checkout_pending")
    .lt("created_at", cutoff)
    // Same test-probe exclusion as listOrders (channel is NOT NULL, default 'storefront' — .neq
    // legitimately drops none of the real orders).
    .neq("channel", "test")
    // Hosted invoice-checkout sessions create no payment_intent row until the buyer completes
    // payment, so listing them here as "abandoned" past the 1h cutoff would invite a merchant to
    // treat an in-flight invoice payment as dead — exclude them, mirroring the reaper's exemption.
    .neq("channel", "invoice")
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
    currency: String(s.currency ?? "usd"),
    createdAt: String(s.created_at),
    recoveryEmailSentAt: s.recovery_email_sent_at == null ? null : String(s.recovery_email_sent_at),
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
