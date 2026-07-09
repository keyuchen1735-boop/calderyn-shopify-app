// app/lib/order/notify-email.server.ts
//
// Order-lifecycle transactional emails: shipping confirmation, refund notice, cancellation
// notice. Sibling to confirmation-email.server.ts and built on the same contract — config-gated
// on RESEND_API_KEY + ORDER_CONFIRM_FROM||PILOT_FROM||DIGEST_FROM, shop-scoped order + buyer
// reads, PII-free logs (order id + shop id only, never the buyer email), never throws. All three
// senders share one lookup (loadOrderAndBuyer) since the guard shape is identical.
//
// Wiring: sendRefundNotice is called from actions/refund.server.ts on the SUCCESS path only, after
// the audit insert, so a replayed (idempotent) refund never re-sends the notice (at-most-once).
// sendShippingConfirmation / sendCancellationNotice are called from their respective fulfillment /
// cancellation flows.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "~/lib/supabase.server";
import { sendEmail } from "~/lib/email/send.server";
import { formatOrderRef } from "./checkout.server";

export interface OrderEmailResult {
  sent: boolean;
  id?: string;
  error?: string;
}

/** Format integer cents for display only. Money stays integer cents everywhere else. */
function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

interface OrderAndBuyer {
  ref: string;
  currency: string;
  email: string;
}

/**
 * Shared shop-scoped lookup: the order (for the display ref + currency) then the buyer's email.
 * Returns null — with a PII-free warning already logged — when the order is missing for this shop
 * or the buyer has no email on file; callers turn that into `{ sent: false }` without calling
 * sendEmail.
 */
async function loadOrderAndBuyer(shopId: string, orderId: string): Promise<OrderAndBuyer | null> {
  const sb: SupabaseClient = getSupabase();
  const orderRes = await sb
    .from("orders")
    .select("id, buyer_id, currency")
    .eq("shop_id", shopId)
    .eq("id", orderId)
    .maybeSingle();
  if (orderRes.error) throw orderRes.error;
  if (!orderRes.data) {
    console.warn(`[order-notify] order ${orderId} not found for shop ${shopId}; no email sent`);
    return null;
  }
  const order = orderRes.data as Record<string, unknown>;
  const buyerId = String(order.buyer_id);

  const buyerRes = await sb
    .from("buyer_dim")
    .select("email_normalized")
    .eq("shop_id", shopId)
    .eq("id", buyerId)
    .maybeSingle();
  if (buyerRes.error) throw buyerRes.error;
  const email = buyerRes.data
    ? String((buyerRes.data as Record<string, unknown>).email_normalized)
    : "";
  if (!email) {
    console.warn(`[order-notify] order ${orderId} (shop ${shopId}) has no buyer email; no email sent`);
    return null;
  }

  return { ref: formatOrderRef(orderId), currency: String(order.currency ?? "usd"), email };
}

/** Resolves the Resend transport config, or null when it isn't configured (fail visibly, rule 12). */
function transportConfig(): { apiKey: string; from: string } | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ORDER_CONFIRM_FROM || process.env.PILOT_FROM || process.env.DIGEST_FROM;
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

/**
 * Send the shipping-confirmation email for an order. Never throws — a delivery failure must not
 * break the fulfillment flow that triggers it.
 */
export async function sendShippingConfirmation(
  shopId: string,
  orderId: string,
  opts: { trackingNumber?: string | null; carrier?: string | null },
): Promise<OrderEmailResult> {
  try {
    if (!shopId || !orderId) {
      return { sent: false, error: "shopId and orderId are required" };
    }

    const found = await loadOrderAndBuyer(shopId, orderId);
    if (!found) {
      return { sent: false, error: "order not found or no buyer email" };
    }

    const config = transportConfig();
    if (!config) {
      console.warn(
        `[order-notify] cannot send shipping confirmation for order ${orderId} (shop ${shopId}): email transport not configured`,
      );
      return { sent: false, error: "email transport not configured" };
    }

    const subject = `Order ${found.ref} is on the way`;
    const trackingLine = opts.trackingNumber
      ? `Tracking: ${opts.carrier ? `${opts.carrier} ` : ""}${opts.trackingNumber}`
      : null;
    const text = [`Good news! Your order ${found.ref} has shipped.`, ...(trackingLine ? ["", trackingLine] : [])].join(
      "\n",
    );
    const html =
      `<p>Good news! Your order ${found.ref} has shipped.</p>` + (trackingLine ? `<p>${trackingLine}</p>` : "");

    const delivery = await sendEmail({ apiKey: config.apiKey, from: config.from, to: found.email, subject, text, html });
    if (!delivery.sent) {
      console.warn(
        `[order-notify] shipping-confirmation delivery failed for order ${orderId} (shop ${shopId}): ${delivery.error ?? "unknown"}`,
      );
    }
    return delivery;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[order-notify] error sending shipping confirmation for order ${orderId} (shop ${shopId}): ${message}`,
    );
    return { sent: false, error: message };
  }
}

/**
 * Send the refund-notice email for an order. Never throws — called best-effort from
 * actions/refund.server.ts after the refund is already recorded, so a delivery failure must not
 * affect the (already-succeeded) refund result.
 */
export async function sendRefundNotice(
  shopId: string,
  orderId: string,
  opts: { amountCents: number },
): Promise<OrderEmailResult> {
  try {
    if (!shopId || !orderId) {
      return { sent: false, error: "shopId and orderId are required" };
    }

    const found = await loadOrderAndBuyer(shopId, orderId);
    if (!found) {
      return { sent: false, error: "order not found or no buyer email" };
    }

    const config = transportConfig();
    if (!config) {
      console.warn(
        `[order-notify] cannot send refund notice for order ${orderId} (shop ${shopId}): email transport not configured`,
      );
      return { sent: false, error: "email transport not configured" };
    }

    const amount = money(opts.amountCents, found.currency);
    const subject = `Refund issued for order ${found.ref}`;
    const text = [
      `We've issued a refund of ${amount} for order ${found.ref}. It should appear on your statement within 5-10 business days.`,
    ].join("\n");
    const html = `<p>We've issued a refund of ${amount} for order ${found.ref}. It should appear on your statement within 5-10 business days.</p>`;

    const delivery = await sendEmail({ apiKey: config.apiKey, from: config.from, to: found.email, subject, text, html });
    if (!delivery.sent) {
      console.warn(
        `[order-notify] refund-notice delivery failed for order ${orderId} (shop ${shopId}): ${delivery.error ?? "unknown"}`,
      );
    }
    return delivery;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[order-notify] error sending refund notice for order ${orderId} (shop ${shopId}): ${message}`);
    return { sent: false, error: message };
  }
}

/**
 * Send the cancellation-notice email for an order. Never throws — a delivery failure must not
 * break the cancellation flow that triggers it.
 */
export async function sendCancellationNotice(
  shopId: string,
  orderId: string,
  opts: { refunded: boolean },
): Promise<OrderEmailResult> {
  try {
    if (!shopId || !orderId) {
      return { sent: false, error: "shopId and orderId are required" };
    }

    const found = await loadOrderAndBuyer(shopId, orderId);
    if (!found) {
      return { sent: false, error: "order not found or no buyer email" };
    }

    const config = transportConfig();
    if (!config) {
      console.warn(
        `[order-notify] cannot send cancellation notice for order ${orderId} (shop ${shopId}): email transport not configured`,
      );
      return { sent: false, error: "email transport not configured" };
    }

    const subject = `Order ${found.ref} has been cancelled`;
    const refundSentence = opts.refunded ? " A full refund has been issued to your original payment method." : "";
    const text = [`Your order ${found.ref} has been cancelled.${refundSentence}`].join("\n");
    const html = `<p>Your order ${found.ref} has been cancelled.${refundSentence}</p>`;

    const delivery = await sendEmail({ apiKey: config.apiKey, from: config.from, to: found.email, subject, text, html });
    if (!delivery.sent) {
      console.warn(
        `[order-notify] cancellation-notice delivery failed for order ${orderId} (shop ${shopId}): ${delivery.error ?? "unknown"}`,
      );
    }
    return delivery;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[order-notify] error sending cancellation notice for order ${orderId} (shop ${shopId}): ${message}`,
    );
    return { sent: false, error: message };
  }
}
