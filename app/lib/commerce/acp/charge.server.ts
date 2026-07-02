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
import { getStripe } from "~/lib/payments/stripe.server";
import { destinationParamsFor, syncAccountStatus } from "~/lib/payments/connect.server";
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
  const dest = await destinationParamsFor(shopId, input.totalCents);
  const base = {
    amount: input.totalCents,
    currency: input.currency.toLowerCase(),
    payment_method: input.sharedPaymentToken,
    confirm: true as const,
    off_session: true as const,
    metadata: { shop_id: shopId, order_ref: input.orderId },
  };

  let routedAccountId = dest.stripeAccountId;
  let appliedFeeCents = dest.applicationFeeCents;
  let pi;
  try {
    pi = await getStripe().paymentIntents.create({ ...base, ...dest.params });
  } catch (err) {
    // ONLY a destination-shaped invalid-request falls back; a card decline
    // (StripeCardError) must propagate — retrying a confirm:true create on a
    // decline would double-attempt the buyer's charge.
    if (routedAccountId && (err as { type?: string }).type === "StripeInvalidRequestError") {
      console.warn(
        `[stripe-connect] ACP destination charge for shop ${shopId} rejected (${(err as Error).message}); falling back to platform charge`,
      );
      void syncAccountStatus(shopId).catch((e) =>
        console.warn(`[stripe-connect] status re-sync failed for shop ${shopId}: ${(e as Error).message}`),
      );
      routedAccountId = null;
      appliedFeeCents = null;
      pi = await getStripe().paymentIntents.create(base);
    } else {
      throw err;
    }
  }
  // Mirror into payment_intent so the webhook + reconciliation can resolve the order
  // (same path as createPaymentIntent for the storefront flow).
  await getSupabase().from("payment_intent").insert({
    shop_id: shopId,
    stripe_pi_id: pi.id,
    order_ref: input.orderId,
    amount_cents: input.totalCents,
    currency: input.currency.toLowerCase(),
    status: pi.status,
    stripe_account_id: routedAccountId,
    application_fee_cents: appliedFeeCents,
  });
  if (pi.status !== "succeeded" && pi.status !== "processing") {
    throw new ChargeDeclinedError(input.orderId, pi.status);
  }
  return { paymentIntentId: pi.id, status: pi.status };
}
