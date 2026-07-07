// The Claude/MCP payment path: a Stripe-hosted Checkout Session for an already-created owned
// order. The single line item is the order TOTAL (the locked quote already itemized
// subtotal/shipping/tax — Stripe Checkout only needs the amount to charge). On payment the
// existing webhooks.stripe.tsx -> processStripeEvent flips the order to `paid` keyed by
// metadata.order_ref, identical to the storefront Payment Element path. We set order_ref on BOTH
// the Session metadata AND payment_intent_data.metadata so it propagates onto the PaymentIntent
// the webhook actually reads (pi.metadata.order_ref in stripe.server.ts:processStripeEvent).
import { getStripe } from "~/lib/payments/stripe.server";

export interface CommerceSessionInput {
  orderId: string;
  totalCents: number;
  currency: string;
  confirmationToken: string;
  /** Where Stripe sends the payer afterward (absolute URLs). Defaults to the buyer
   *  storefront confirmation/cart pages; merchant-facing flows (the go-live payment
   *  probe) override this to return to the dashboard instead. */
  returnUrls?: { success: string; cancel: string };
}

/**
 * Canonical app origin for the buyer-facing success/cancel pages — the storefront confirmation
 * route (/storefront/checkout/confirmation/:token) is served by THIS app. Prefer an explicit
 * STOREFRONT_BASE_URL, then the existing app-origin envs (PUBLIC_APP_URL -> SHOPIFY_APP_URL) so
 * the redirect URLs are absolute in practice rather than a broken relative path.
 */
function storefrontBaseUrl(): string {
  return process.env.STOREFRONT_BASE_URL ?? process.env.PUBLIC_APP_URL ?? process.env.SHOPIFY_APP_URL ?? "";
}

export async function createCommerceCheckoutSession(
  shopId: string,
  input: CommerceSessionInput,
): Promise<{ sessionId: string; url: string }> {
  if (!shopId) throw new Error("shopId is required");
  const base = storefrontBaseUrl();
  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: input.currency,
        unit_amount: input.totalCents,
        product_data: { name: `Order ${input.orderId.slice(0, 8).toUpperCase()}` },
      },
    }],
    metadata: { shop_id: shopId, order_ref: input.orderId },
    payment_intent_data: { metadata: { shop_id: shopId, order_ref: input.orderId } },
    success_url:
      input.returnUrls?.success ?? `${base}/storefront/checkout/confirmation/${input.confirmationToken}`,
    cancel_url: input.returnUrls?.cancel ?? `${base}/storefront/cart`,
  });
  if (!session.url) throw new Error(`Stripe Checkout Session ${session.id} returned no url`);
  return { sessionId: session.id, url: session.url };
}
