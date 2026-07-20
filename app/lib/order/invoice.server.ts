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
import { getShopStorefrontOrigin } from "~/lib/storefront/shop.server";
import { sendInvoiceEmail } from "./notify-email.server";

export interface InvoiceBuyerInput {
  email: string;
  address?: BuyerAddressInput;
  note?: string | null;
  /** Exchange-lite (Phase 4 Task 2): when this invoice is a replacement order for a closed return,
   *  the return's id — stamped into the new order's attribution as `{ exchange_for }` so the two
   *  orders are traceably linked without coupling their money: the return's refund and this
   *  invoice's charge are separate transactions, never netted against each other. Validated as a
   *  uuid at the route boundary before it ever reaches here. */
  exchangeForReturnId?: string | null;
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

  // ATOMIC CLAIM (fix I2): flip the draft cart cart -> checkout_pending FIRST, gated on the exact
  // row shape a real, not-yet-sent draft must have (shop_id + id + state='cart' +
  // origin='merchant_draft'). This is a single CAS UPDATE, not a read-then-write — two concurrent
  // sends for the same draft (a double-click, or a retried request) can only have ONE winner: the
  // loser's WHERE clause matches zero rows because the winner already flipped `state`, so it can
  // never fall through to price + insert a second order off the same cart. The old shape (read the
  // cart, check origin/state, act, THEN mark it consumed at the very end) left exactly that gap
  // open — two concurrent callers could both pass the read-time check before either write landed.
  const claim = await sb
    .from("cart")
    .update({ state: "checkout_pending" })
    .eq("shop_id", shopId)
    .eq("id", cartId)
    .eq("state", "cart")
    .eq("origin", "merchant_draft")
    .select("id");
  if (claim.error) throw claim.error;
  if (!claim.data || (Array.isArray(claim.data) && claim.data.length === 0)) {
    // Zero rows claimed: either this was never a merchant-draft cart at all (404), or it WAS one
    // but already got sent (409) — a follow-up read (outside the CAS) distinguishes the two so the
    // caller sees the right error shape, same two codes the old read-first guard produced.
    const cartRes = await sb.from("cart").select("id, origin").eq("shop_id", shopId).eq("id", cartId).maybeSingle();
    if (cartRes.error) throw cartRes.error;
    const cartRow = cartRes.data as Record<string, unknown> | null;
    if (!cartRow || cartRow.origin !== "merchant_draft") {
      throw new CalderynError({
        code: "not_a_draft",
        status: 404,
        message: `No merchant draft cart ${cartId} found for this shop.`,
      });
    }
    throw new CalderynError({
      code: "draft_already_sent",
      status: 409,
      message: `Draft cart ${cartId} was already invoiced; refusing to send a duplicate.`,
    });
  }

  // Best-effort revert: put the cart back to 'cart' so the merchant can retry, without ever
  // rethrowing a SECOND error over the one that actually failed (rule 12 — surface the real cause).
  async function revertClaim(): Promise<void> {
    try {
      const revert = await sb.from("cart").update({ state: "cart" }).eq("shop_id", shopId).eq("id", cartId);
      if (revert.error) throw revert.error;
    } catch (revertErr) {
      console.error(
        `[invoice] could not revert draft cart ${cartId} (shop ${shopId}) back to 'cart' after send failed — the merchant may need to re-save the draft`,
        revertErr,
      );
    }
  }

  let orderId: string;
  let priced: Awaited<ReturnType<typeof priceCart>>;
  let totalCents: number;
  let confirmationToken: string;
  try {
    priced = await priceCart(shopId, cartId);
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

    // Exchange-lite (Phase 4 Task 2): before any writes, verify that an exchange_for_return_id
    // (if provided) refers to a real, shop-scoped return. A foreign return (from another shop) or
    // a non-existent return must never be referenced in attribution — the link would be invalid
    // and attribution must always resolve to a real return when present.
    if (buyer.exchangeForReturnId) {
      const returnCheck = await sb
        .from("order_return")
        .select("id")
        .eq("shop_id", shopId)
        .eq("id", buyer.exchangeForReturnId)
        .maybeSingle();
      if (returnCheck.error) throw returnCheck.error;
      if (!returnCheck.data) {
        throw new CalderynError({
          code: "unknown_return",
          status: 422,
          message: `Return ${buyer.exchangeForReturnId} not found for this shop.`,
        });
      }
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
    totalCents = priced.subtotalCents + shippingCents + taxCents;

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
    confirmationToken = randomBytes(32).toString("base64url");
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
        attribution: {
          channel: "invoice",
          ...(buyer.exchangeForReturnId ? { exchange_for: buyer.exchangeForReturnId } : {}),
        },
        confirmation_token: confirmationToken,
      })
      .select("id")
      .single();
    if (orderIns.error) throw orderIns.error;
    if (!orderIns.data) throw new Error("orders insert returned no row");
    orderId = String((orderIns.data as Record<string, unknown>).id);
  } catch (err) {
    // Everything above happened AFTER the cart claimed checkout_pending but BEFORE the order
    // actually exists — revert the claim so the draft is retryable rather than stranded
    // checkout_pending forever with no order and no way back into the composer.
    await revertClaim();
    throw err;
  }

  // Cost snapshot (Phase 4 Task 1): same posture as checkout.server.ts's createCheckout — stamp
  // unit_cost_cents_snapshot from variant_dim at line-build time so a later catalog cost change
  // never re-prices an already-invoiced line's profit read model. priceCart's snapshot has no cost
  // column (buyer-facing price/title only), so this is a dedicated, cost-only read.
  let costByVariant = new Map<string, number | null>();
  try {
    const variantCostRes = await sb
      .from("variant_dim")
      .select("id, unit_cost_cents")
      .eq("shop_id", shopId)
      .in("id", priced.lines.map((l) => l.variantId));
    if (variantCostRes.error) throw variantCostRes.error;
    costByVariant = new Map(
      ((variantCostRes.data ?? []) as Record<string, unknown>[]).map((r) => [
        String(r.id),
        r.unit_cost_cents == null ? null : Number(r.unit_cost_cents),
      ]),
    );
  } catch (err) {
    // Same stranded-order risk the lineIns failure below guards against: by this point the cart is
    // already claimed checkout_pending and a zero-line order already exists. Revert both so the
    // merchant can retry, then rethrow the ORIGINAL error (rule 12).
    await revertClaim();
    const orderDel = await sb.from("orders").delete().eq("shop_id", shopId).eq("id", orderId);
    if (orderDel.error) {
      console.error(
        `[invoice] variant cost lookup failed for order ${orderId} (shop ${shopId}); cart ${cartId} was reverted ` +
          `to 'cart', but the zero-line order could NOT be deleted and needs manual cleanup`,
        orderDel.error,
      );
    } else {
      console.error(
        `[invoice] variant cost lookup failed for order ${orderId} (shop ${shopId}); cart ${cartId} reverted to ` +
          `'cart' and the zero-line order was deleted`,
        err,
      );
    }
    throw err;
  }

  const lineRows = priced.lines.map((l) => ({
    shop_id: shopId,
    order_id: orderId,
    variant_id: l.variantId,
    quantity: l.quantity,
    unit_price_cents: l.unitPriceCents,
    title_snapshot: l.titleSnapshot,
    personalization: l.personalization,
    unit_cost_cents_snapshot: costByVariant.get(l.variantId) ?? null,
  }));
  const lineIns = await sb.from("order_line").insert(lineRows);
  if (lineIns.error) {
    // Revert gap (flagged twice independently): by this point the cart is already claimed
    // checkout_pending (unretryable — the CAS above never runs twice) AND a zero-line `orders` row
    // already exists. Leaving either behind here strands the draft: the merchant can neither retry
    // sending it (the claim is gone) nor see it (it has no lines), with no way back into the
    // composer. Best-effort-undo BOTH — revert the cart to 'cart', delete the just-created
    // zero-line order (shop-scoped, by id) — then rethrow the ORIGINAL error either way (rule 12:
    // a cleanup failure is logged loudly, never masks the real cause).
    await revertClaim();
    const orderDel = await sb.from("orders").delete().eq("shop_id", shopId).eq("id", orderId);
    if (orderDel.error) {
      console.error(
        `[invoice] order_line insert failed for order ${orderId} (shop ${shopId}); cart ${cartId} was reverted ` +
          `to 'cart', but the zero-line order could NOT be deleted and needs manual cleanup`,
        orderDel.error,
      );
    } else {
      console.error(
        `[invoice] order_line insert failed for order ${orderId} (shop ${shopId}); cart ${cartId} reverted to ` +
          `'cart' and the zero-line order was deleted`,
        lineIns.error,
      );
    }
    throw lineIns.error;
  }

  // Deliberately NO reserveStock and NO createPaymentIntent here: the draft becomes a real order
  // the moment the invoice is sent, but nothing is held or charged until the buyer opens the pay
  // link (payableInvoiceSession mints the PaymentIntent lazily via Stripe Checkout).

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

  // Fix C1: the hosted session's success/cancel URLs must resolve back to THIS shop's own
  // storefront — createCommerceCheckoutSession defaults to the PLATFORM app host
  // (stripe-checkout.server.ts's storefrontBaseUrl()) when no returnUrls are supplied, which is
  // fine for the go-live payment probe (a dashboard-side caller) but wrong here: a buyer bounced
  // back to `app.calderyncompany.com/storefront/checkout/confirmation/:token` resolves to the
  // platform's OWN (demo) shop, not this tenant's, and 500s trying to load someone else's order.
  // Resolve the tenant's real origin FIRST — a shop with no live storefront (no org_slug yet)
  // can't mint a session with a working return trip, so it reuses payableInvoiceSession's
  // existing "not_ready" shape rather than minting a session that can never send the buyer home.
  const origin = await getShopStorefrontOrigin(shopId);
  if (!origin) return { kind: "not_ready" };

  // Expire the PRIOR hosted session (if any) before minting a replacement — see the module
  // comment for why this only narrows, rather than closes, the double-pay race. Best-effort:
  // Stripe throws when the session is already completed or already expired, and either case
  // means there is nothing left to expire, so we swallow it rather than fail the pay link over
  // a session that is already gone.
  const priorSessionId = row.invoice_session_id ? String(row.invoice_session_id) : null;
  if (priorSessionId) {
    await expireStripeSessionBestEffort(priorSessionId);
  }

  let session: { sessionId: string; url: string };
  try {
    session = await createCommerceCheckoutSession(shopId, {
      orderId,
      totalCents: Number(row.total_cents),
      currency: String(row.currency),
      confirmationToken: token,
      returnUrls: {
        success: `${origin}/storefront/checkout/confirmation/${token}`,
        cancel: `${origin}/storefront/invoice/${token}/pay`,
      },
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

/**
 * Fix C2: kill an invoice's currently-persisted hosted Checkout Session (if any) and clear
 * orders.invoice_session_id, so a buyer with the OLD pay link open can never complete a payment
 * against an order that is about to be voided or wholesale-repriced. Called from the two seams
 * where the order's money picture moves out from under an already-minted session: cancelling an
 * invoice-channel order (cancel.server.ts's executeCancelAction) and the START of an unpaid
 * invoice's line edit (edit.server.ts's executeEditInvoiceLines, before repricing). Shares
 * payableInvoiceSession's own best-effort posture: Stripe throws when the session is already
 * completed or already expired, and either case means there is nothing left to do, so that failure
 * is swallowed rather than blocking the caller's own (already-decided) state change.
 */
export async function expireInvoiceSession(shopId: string, orderId: string): Promise<void> {
  if (!shopId || !orderId) return;
  const sb = getSupabase();
  const res = await sb.from("orders").select("invoice_session_id").eq("shop_id", shopId).eq("id", orderId).maybeSingle();
  if (res.error) throw res.error;
  const row = res.data as Record<string, unknown> | null;
  const sessionId = row?.invoice_session_id ? String(row.invoice_session_id) : null;
  if (!sessionId) return;

  await expireStripeSessionBestEffort(sessionId);

  const clear = await sb.from("orders").update({ invoice_session_id: null }).eq("shop_id", shopId).eq("id", orderId);
  if (clear.error) throw clear.error;
}

/**
 * Best-effort expire of a Stripe hosted Checkout Session, shared by payableInvoiceSession
 * (expiring the PRIOR session before minting a replacement) and expireInvoiceSession (killing the
 * currently-persisted session outright). Stripe throws when the session is already completed or
 * already expired, and either case means there is nothing left to do — that failure is swallowed
 * rather than propagated (both callers have their own already-decided state change to make), but
 * it is NOT silent (rule 12): a one-line console.warn names the session id and the Stripe error so
 * a genuine API/auth failure is still visible, distinct from the routine already-gone case.
 */
async function expireStripeSessionBestEffort(sessionId: string): Promise<void> {
  try {
    await getStripe().checkout.sessions.expire(sessionId);
  } catch (err) {
    console.warn(`[invoice] could not expire Stripe session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
