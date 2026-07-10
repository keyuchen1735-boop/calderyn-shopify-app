// app/lib/order/invoice.server.ts
// Merchant-invoice backend (orders phase 3, Task 2): turn a merchant-drafted cart
// (origin='merchant_draft') into a real `orders` row (channel='invoice') and email the buyer a
// pay link, WITHOUT ever holding stock or opening a Stripe PaymentIntent up front — payment is
// minted lazily, only when the buyer actually opens the pay link (payableInvoiceSession).
//
// sendDraftOrderInvoice mirrors createCheckout's pricing/order-insert shape (checkout.server.ts)
// verbatim wherever the shapes agree: same paymentsReadiness fail-closed gate, same
// priceCart -> quoteCart -> total-guard -> buyer upsert -> orders/order_line insert -> cart
// consumed sequence. It deliberately DROPS createCheckout's reserveStock block and PaymentIntent
// creation (an invoice is not a checkout — the buyer hasn't paid, or even necessarily agreed to
// buy, yet) and never records consent (the merchant is entering this on the buyer's behalf).
//
// payableInvoiceSession is STATEFUL-LITE (migration 20260710170000): it persists the id of the
// last hosted Checkout Session it minted on orders.invoice_session_id. Each call for a still-
// pending invoice best-effort EXPIRES that prior session before minting a replacement, so a
// buyer with two open tabs (or a merchant who resent the pay link) cannot complete two payments
// against the same invoice. This narrows, but does not close, the race: completing the prior
// session in the gap between its expire call and the new session's persist still produces a
// second successful PaymentIntent. That surplus-capture case is caught loudly (not silently) by
// the webhook's already-paid guard in stripe.server.ts rather than prevented here.
import { randomBytes } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { CalderynError } from "~/lib/calderyn.server";
import { priceCart } from "./cart.server";
import { upsertGuestBuyer, addBuyerAddress, type BuyerAddressInput } from "~/lib/buyer/identity.server";
import { paymentsReadiness } from "~/lib/payments/connect.server";
import { quoteCart } from "~/lib/commerce/quote.server";
import { isSupportedCurrency } from "~/lib/payments/stripe.server";
import { getStripe } from "~/lib/payments/stripe-client.server";
import { createCommerceCheckoutSession } from "~/lib/commerce/stripe-checkout.server";
import { PaymentsNotReadyError } from "~/lib/payments/errors";
import { sendInvoiceEmail } from "./notify-email.server";

export interface InvoiceBuyerInput {
  email: string;
  address?: BuyerAddressInput;
  note?: string | null;
}

export interface SendInvoiceResult {
  orderId: string;
  confirmationToken: string;
  totalCents: number;
  currency: string;
  emailSent: boolean;
}

/**
 * Send a merchant-drafted invoice: price the draft cart, identify the buyer, persist the order
 * (channel='invoice', born checkout_pending like every other order), and email the buyer a pay
 * link. Fails visibly (rule 12) before any write when the shop can't take payments, the cart
 * isn't a merchant draft, it has no lines, or the total is zero — never an orphan invoice a
 * buyer can never actually pay.
 */
export async function sendDraftOrderInvoice(
  shopId: string,
  cartId: string,
  buyer: InvoiceBuyerInput,
): Promise<SendInvoiceResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!cartId) throw new Error("cartId is required");
  if (!buyer?.email) throw new Error("buyer.email is required to send an invoice");

  // Fail CLOSED before any write, mirroring createCheckout: a merchant must never be able to
  // hand a buyer a pay link this shop cannot actually be charged through (the money would have
  // nowhere legitimate to settle).
  const readiness = await paymentsReadiness(shopId);
  if (!readiness.ready) {
    throw new CalderynError({
      code: "payments_not_ready",
      status: 409,
      message: "This store isn't accepting payments yet. Finish Stripe setup before sending an invoice.",
    });
  }

  const sb = getSupabase();
  const cartRes = await sb
    .from("cart")
    .select("id, origin, state")
    .eq("shop_id", shopId)
    .eq("id", cartId)
    .maybeSingle();
  if (cartRes.error) throw cartRes.error;
  const cartRow = cartRes.data as Record<string, unknown> | null;
  if (!cartRow || cartRow.origin !== "merchant_draft") {
    throw new CalderynError({
      code: "not_a_draft",
      status: 404,
      message: `No merchant draft cart ${cartId} found for this shop.`,
    });
  }
  // Two-field guard mirroring isMerchantDraftCart (merchant-drafts.server.ts): origin alone is
  // not enough — a draft that already sent (cart.state advanced past 'cart' at the bottom of
  // this function) must never be invoiced a second time. Without this a double-click / retried
  // request on the send-invoice button would price + insert a SECOND order and email a SECOND
  // pay link off the same consumed draft. Kept as its own check (not a reuse of the boolean
  // helper) so the two failure shapes stay distinguishable: "never was a draft" (404) vs.
  // "was a draft, already sent" (409).
  if (cartRow.state !== "cart") {
    throw new CalderynError({
      code: "draft_already_sent",
      status: 409,
      message: `Draft cart ${cartId} was already invoiced; refusing to send a duplicate.`,
    });
  }

  const priced = await priceCart(shopId, cartId);
  if (priced.lines.length === 0) {
    throw new CalderynError({
      code: "empty_draft",
      status: 422,
      message: "This draft has no line items to invoice.",
    });
  }

  // Mirrors createCheckout's address guard: reject a shipping address missing a street BEFORE
  // calling quoteCart (an empty street produces an opaque carrier error), and before any
  // buyer/order write.
  if (buyer.address && !buyer.address.line1) {
    throw new Error("shipping address line1 is required to quote");
  }
  let shippingCents = 0;
  let taxCents = 0;
  if (buyer.address) {
    const quoted = await quoteCart(
      shopId,
      priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      {
        street1: buyer.address.line1 ?? "",
        street2: buyer.address.line2 ?? undefined,
        city: buyer.address.city ?? "",
        state: buyer.address.region ?? "",
        zip: buyer.address.postal ?? "",
        country: buyer.address.country ?? "US",
      },
      { subtotalCentsOverride: priced.subtotalCents },
    );
    shippingCents = quoted.shippingCents;
    taxCents = quoted.taxCents;
  }
  const totalCents = priced.subtotalCents + shippingCents + taxCents;

  // Fail visibly BEFORE any buyer/order write, same as createCheckout's total guard: a non-empty
  // draft that totals 0 cents (all-free lines) must reject here, not after writing rows a
  // pay-link can never actually charge.
  if (totalCents <= 0) {
    throw new CalderynError({
      code: "zero_total",
      status: 422,
      message: `cannot invoice cart ${cartId}: nothing to charge (total ${totalCents} cents)`,
    });
  }
  if (!isSupportedCurrency(priced.currency)) {
    throw new Error(`cannot invoice cart ${cartId}: unsupported currency '${priced.currency}'`);
  }

  // No consent capture: the merchant is entering this invoice on the buyer's behalf, not the
  // buyer accepting ToS/privacy themselves at checkout.
  const buyerRow = await upsertGuestBuyer(shopId, { email: buyer.email });
  if (buyer.address) {
    await addBuyerAddress(shopId, buyerRow.id, buyer.address);
  }

  // Same unguessable 256-bit token every order-origination path mints (checkout.server.ts,
  // commerce/order.server.ts) — the pay-link/confirmation-page auth boundary.
  const confirmationToken = randomBytes(32).toString("base64url");
  const orderIns = await sb
    .from("orders")
    .insert({
      shop_id: shopId,
      buyer_id: buyerRow.id,
      channel: "invoice",
      subtotal_cents: priced.subtotalCents,
      shipping_cents: shippingCents,
      tax_cents: taxCents,
      total_cents: totalCents,
      currency: priced.currency,
      attribution: { channel: "invoice" },
      confirmation_token: confirmationToken,
    })
    .select("id")
    .single();
  if (orderIns.error) throw orderIns.error;
  if (!orderIns.data) throw new Error("orders insert returned no row");
  const orderId = String((orderIns.data as Record<string, unknown>).id);

  const lineRows = priced.lines.map((l) => ({
    shop_id: shopId,
    order_id: orderId,
    variant_id: l.variantId,
    quantity: l.quantity,
    unit_price_cents: l.unitPriceCents,
    title_snapshot: l.titleSnapshot,
  }));
  const lineIns = await sb.from("order_line").insert(lineRows);
  if (lineIns.error) throw lineIns.error;

  // Deliberately NO reserveStock and NO createPaymentIntent here: the draft becomes a real order
  // the moment the invoice is sent, but nothing is held or charged until the buyer opens the pay
  // link (payableInvoiceSession mints the PaymentIntent lazily via Stripe Checkout).
  const cartUpd = await sb
    .from("cart")
    .update({ state: "checkout_pending" })
    .eq("shop_id", shopId)
    .eq("id", cartId);
  if (cartUpd.error) {
    console.warn(`[invoice] could not mark draft cart ${cartId} consumed (shop ${shopId}): ${cartUpd.error.message}`);
  }

  const delivery = await sendInvoiceEmail(shopId, orderId, {
    confirmationToken,
    lines: priced.lines.map((l) => ({ title: l.titleSnapshot, quantity: l.quantity })),
    totalCents,
    note: buyer.note ?? null,
  });

  return {
    orderId,
    confirmationToken,
    totalCents,
    currency: priced.currency,
    emailSent: delivery.sent,
  };
}

export interface ResendInvoiceResult {
  sent: boolean;
  reason?: string;
}

/**
 * Re-send the buyer-facing pay-link email for an UNPAID invoice order (Phase 3 Task 5). The pay
 * link itself (confirmation_token) never changes across a resend — payableInvoiceSession mints a
 * fresh Stripe Checkout Session lazily whenever the buyer actually opens it, so resending is just
 * sendInvoiceEmail replayed off the order's CURRENT lines/total, not a new order-origination path.
 * Only available while the invoice is still unpaid (channel='invoice', state='checkout_pending');
 * a paid/void/cancelled invoice has no pay link left to resend (Void is the merchant's action on
 * those instead).
 */
export async function resendInvoiceEmail(shopId: string, orderId: string): Promise<ResendInvoiceResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!orderId) {
    throw new CalderynError({ code: "invalid_order", status: 422, message: "orderId is required." });
  }

  const sb = getSupabase();
  const orderRes = await sb
    .from("orders")
    .select("id, channel, state, confirmation_token, total_cents, currency")
    .eq("shop_id", shopId)
    .eq("id", orderId)
    .maybeSingle();
  if (orderRes.error) throw orderRes.error;
  const order = orderRes.data as Record<string, unknown> | null;
  if (!order) {
    throw new CalderynError({ code: "order_not_found", status: 404, message: `Order ${orderId} not found.` });
  }
  if (order.channel !== "invoice") {
    throw new CalderynError({
      code: "not_an_invoice",
      status: 409,
      message: `Order ${orderId} is not an invoice order.`,
    });
  }
  if (order.state !== "checkout_pending") {
    throw new CalderynError({
      code: "invoice_not_pending",
      status: 409,
      message: `Order ${orderId} is '${String(order.state)}'; only an unpaid invoice's pay link can be resent.`,
    });
  }
  const token = order.confirmation_token ? String(order.confirmation_token) : "";
  if (!token) {
    // A pending invoice always carries a token (minted at send time) — a missing one is a data
    // anomaly, surfaced as a typed error rather than an opaque 500.
    throw new CalderynError({
      code: "no_pay_link",
      status: 409,
      message: `Invoice order ${orderId} has no pay link to resend.`,
    });
  }

  const linesRes = await sb
    .from("order_line")
    .select("title_snapshot, quantity")
    .eq("shop_id", shopId)
    .eq("order_id", orderId);
  if (linesRes.error) throw linesRes.error;
  const lines = ((linesRes.data ?? []) as Array<Record<string, unknown>>).map((l) => ({
    title: String(l.title_snapshot ?? ""),
    quantity: Number(l.quantity ?? 0),
  }));

  const delivery = await sendInvoiceEmail(shopId, orderId, {
    confirmationToken: token,
    lines,
    totalCents: Number(order.total_cents ?? 0),
  });

  return { sent: delivery.sent, reason: delivery.reason };
}

export type PayableInvoiceSession =
  | { kind: "pay"; url: string }
  | { kind: "paid"; confirmationToken: string }
  | { kind: "void" }
  | { kind: "not_ready" };

// States that mean the invoice was already paid (or is further along than paid) — the pay-link
// route sends the buyer straight to the existing confirmation page rather than minting a new
// session for an order that no longer needs one.
const PAID_STATES = new Set(["paid", "partially_fulfilled", "fulfilled", "partially_refunded"]);
// Terminal states where the invoice can never be paid.
const VOID_STATES = new Set(["cancelled", "refunded"]);

/**
 * Resolve a hosted-invoice pay link by its confirmation token, shop-scoped. Returns null for an
 * unknown token OR an order that isn't channel='invoice' (same IDOR-safe posture as
 * findOrderByConfirmationToken) — the pay route 404s on null rather than distinguishing "wrong
 * shop" from "not an invoice" to an unauthenticated caller.
 */
export async function payableInvoiceSession(
  shopId: string,
  token: string,
): Promise<PayableInvoiceSession | null> {
  if (!shopId || !token) return null;

  const sb = getSupabase();
  const orderRes = await sb
    .from("orders")
    .select("id, state, channel, total_cents, currency, invoice_session_id")
    .eq("shop_id", shopId)
    .eq("confirmation_token", token)
    .maybeSingle();
  if (orderRes.error) throw orderRes.error;
  const row = orderRes.data as Record<string, unknown> | null;
  if (!row || row.channel !== "invoice") return null;

  const state = String(row.state);
  if (PAID_STATES.has(state)) return { kind: "paid", confirmationToken: token };
  if (VOID_STATES.has(state)) return { kind: "void" };

  const orderId = String(row.id);

  // Expire the PRIOR hosted session (if any) before minting a replacement — see the module
  // comment for why this only narrows, rather than closes, the double-pay race. Best-effort:
  // Stripe throws when the session is already completed or already expired, and either case
  // means there is nothing left to expire, so we swallow it rather than fail the pay link over
  // a session that is already gone.
  const priorSessionId = row.invoice_session_id ? String(row.invoice_session_id) : null;
  if (priorSessionId) {
    try {
      await getStripe().checkout.sessions.expire(priorSessionId);
    } catch {
      // Already completed or already expired — nothing to do.
    }
  }

  let session: { sessionId: string; url: string };
  try {
    session = await createCommerceCheckoutSession(shopId, {
      orderId,
      totalCents: Number(row.total_cents),
      currency: String(row.currency),
      confirmationToken: token,
    });
  } catch (err) {
    // The shop's Stripe readiness can regress AFTER the invoice was originally sent (e.g. the
    // merchant's Connect account got disabled). Rather than 500 a buyer trying to pay, hand the
    // route a friendly "not ready" kind it can render as a standalone page.
    if (err instanceof PaymentsNotReadyError) return { kind: "not_ready" };
    throw err;
  }

  const persist = await sb
    .from("orders")
    .update({ invoice_session_id: session.sessionId })
    .eq("shop_id", shopId)
    .eq("id", orderId);
  if (persist.error) throw persist.error;

  return { kind: "pay", url: session.url };
}
