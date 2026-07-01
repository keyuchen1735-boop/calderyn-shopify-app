// The ChatGPT/ACP payment path: charge the buyer's delegated Shared Payment Token through
// Stripe, server-side, no browser hop. The SPT is a Stripe payment-method-like token scoped to
// this merchant + amount. We confirm synchronously; the existing webhooks.stripe.tsx still
// flips the order to `paid` on payment_intent.succeeded (single paid path). A non-succeeded
// status is surfaced as a decline (rule 12) so we never mark a failed charge as an order.
//
// NOTE: confirm the exact SPT field name in the ACP `complete` payload and whether Stripe
// expects it as `payment_method` or a `payment_method_data`/network-token shape — this depends
// on the Stripe ACP integration mode enabled during onboarding. Adjust the `create` call;
// the surrounding flow (cap → place → charge → complete) is the stable invariant.
import { createRoutedPaymentIntent } from "~/lib/payments/connect.server";
import { getSupabase } from "~/lib/supabase.server";

export class ChargeDeclinedError extends Error {
  code = "CHARGE_DECLINED";
  constructor(orderId: string, status: string) {
    super(`charge for order ${orderId} not completed (status: ${status})`);
  }
}

export interface SptChargeInput {
  orderId: string;
  totalCents: number;
  currency: string;
  sharedPaymentToken: string;
}

export async function chargeSharedPaymentToken(
  shopId: string,
  input: SptChargeInput,
): Promise<{ paymentIntentId: string; status: string }> {
  // Routing decision + destination→platform fallback live in ONE seam shared
  // with the storefront path. The helper NEVER retries a card decline — a
  // confirm:true create can only fall back on pre-authorization (400/404)
  // destination-param rejections, so the buyer cannot be double-attempted.
  const { pi, stripeAccountId, applicationFeeCents } = await createRoutedPaymentIntent(
    shopId,
    {
      amount: input.totalCents,
      currency: input.currency.toLowerCase(),
      payment_method: input.sharedPaymentToken,
      confirm: true,
      off_session: true,
      metadata: { shop_id: shopId, order_ref: input.orderId },
    },
    {
      logLabel: "ACP",
      // Idempotency key: a retried `complete` for the same order must reuse the
      // existing PaymentIntent rather than create+confirm a second real charge.
      idempotencyKey: `acp_charge_${input.orderId}`,
    },
  );
  // Mirror into payment_intent so the webhook + reconciliation can resolve the order
  // (same path as createPaymentIntent for the storefront flow). The buyer is already
  // charged (confirm:true) — a failed persist must surface (rule 12), not return a
  // false success the webhook can never reconcile.
  const { error } = await getSupabase().from("payment_intent").insert({
    shop_id: shopId,
    stripe_pi_id: pi.id,
    order_ref: input.orderId,
    amount_cents: input.totalCents,
    currency: input.currency.toLowerCase(),
    status: pi.status,
    stripe_account_id: stripeAccountId,
    application_fee_cents: applicationFeeCents,
  });
  if (error) throw error;
  if (pi.status !== "succeeded" && pi.status !== "processing") {
    throw new ChargeDeclinedError(input.orderId, pi.status);
  }
  return { paymentIntentId: pi.id, status: pi.status };
}
