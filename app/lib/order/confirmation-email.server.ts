// Order-confirmation email (platform pivot #2c-2). Server-only. Sends a brief "order confirmed"
// email to the buyer once Stripe confirms payment — wired from the payment_intent.succeeded
// webhook (stripe.server.ts), gated on FIRST delivery, so the email is at-most-once and only
// ever sent for an order that is genuinely paid (rule 12: never claim a confirmation that did
// not happen). Reuses the repo's existing transactional sender (lib/email/send.server.ts ->
// Resend); no new email dependency, no new plaintext secret (RESEND_API_KEY already exists).
//
// PII hygiene: the buyer email is read here (server-side) ONLY to address the message; it is
// NEVER logged. The structured result logged on failure carries the order id + shop id only.
// Never throws — a delivery failure must not break webhook processing.

import { getSupabase } from "~/lib/supabase.server";
import { sendEmail } from "~/lib/email/send.server";
import { formatOrderRef } from "./checkout.server";

export interface OrderConfirmationResult {
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

/**
 * Send the order-confirmation email for a paid order. Loads the order total + the buyer email
 * (shop-scoped on every read), renders a brief receipt, and delivers it via Resend. Returns a
 * structured result; NEVER throws. Missing config (RESEND_API_KEY / from address) or a delivery
 * failure is surfaced visibly (rule 12) and returned, not raised.
 */
export async function sendOrderConfirmation(
  shopId: string,
  orderId: string,
): Promise<OrderConfirmationResult> {
  try {
    if (!shopId || !orderId) {
      return { sent: false, error: "shopId and orderId are required" };
    }

    const sb = getSupabase();
    const orderRes = await sb
      .from("orders")
      .select("id, buyer_id, total_cents, currency")
      .eq("shop_id", shopId)
      .eq("id", orderId)
      .maybeSingle();
    if (orderRes.error) throw orderRes.error;
    if (!orderRes.data) {
      console.warn(`[order-confirm] order ${orderId} not found for shop ${shopId}; no email sent`);
      return { sent: false, error: "order not found" };
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
      console.warn(`[order-confirm] order ${orderId} (shop ${shopId}) has no buyer email; no email sent`);
      return { sent: false, error: "no buyer email" };
    }

    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.ORDER_CONFIRM_FROM || process.env.PILOT_FROM || process.env.DIGEST_FROM;
    if (!apiKey || !from) {
      // Fail visibly (rule 12) — the order is paid but we could not notify the buyer.
      console.warn(
        `[order-confirm] cannot send confirmation for order ${orderId} (shop ${shopId}): missing ${!apiKey ? "RESEND_API_KEY" : "ORDER_CONFIRM_FROM/PILOT_FROM/DIGEST_FROM"}`,
      );
      return { sent: false, error: "email transport not configured" };
    }

    const ref = formatOrderRef(orderId);
    const total = money(Number(order.total_cents), String(order.currency));
    const subject = `Order ${ref} confirmed`;
    const text = [
      `Thanks for your order!`,
      ``,
      `Order reference: ${ref}`,
      `Total: ${total}`,
      ``,
      `We've received your payment and your order is being processed.`,
    ].join("\n");
    const html =
      `<p>Thanks for your order!</p>` +
      `<p><strong>Order reference:</strong> ${ref}<br/>` +
      `<strong>Total:</strong> ${total}</p>` +
      `<p>We've received your payment and your order is being processed.</p>`;

    const delivery = await sendEmail({ apiKey, from, to: email, subject, text, html });
    if (!delivery.sent) {
      // PII-free failure log: order + shop only, never the buyer email.
      console.warn(
        `[order-confirm] delivery failed for order ${orderId} (shop ${shopId}): ${delivery.error ?? "unknown"}`,
      );
    }
    return delivery;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[order-confirm] error sending confirmation for order ${orderId} (shop ${shopId}): ${message}`);
    return { sent: false, error: message };
  }
}
