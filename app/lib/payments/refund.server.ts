import type Stripe from "stripe";
import { getStripe } from "./stripe-client.server";

/**
 * The single Stripe-refund seam (platform pivot #3b). Isolates the SDK call the way
 * connect.server's createRoutedPaymentIntent isolates PI creation, so the refund executor
 * (app/lib/actions/refund.server.ts) is unit-testable without a live Stripe client and the
 * connected-account handling lives in one place.
 *
 * Connect: our PaymentIntents are created on the PLATFORM account (connect.server routes with
 * transfer_data.destination + on_behalf_of, so the charge itself stays on the platform). A refund
 * is therefore created on the platform account too. When the charge WAS destination-routed
 * (stripeAccountId present), reverse_transfer + refund_application_fee unwind the connected
 * account's balance and our application fee proportionally — without them the refunded money would
 * come out of the platform balance while the connected account kept the transfer.
 *
 * Idempotency: the caller's idempotencyKey is handed to Stripe so a retried refund of the same
 * order/amount returns the SAME re_... refund rather than charging back twice.
 */
export interface StripeRefundInput {
  /** pi_... — the PaymentIntent to refund (from payment_intent.stripe_pi_id). */
  paymentIntentId: string;
  /** Positive refund magnitude in cents. */
  amountCents: number;
  /** acct_... when the charge was destination-routed; null for a platform charge. */
  stripeAccountId: string | null;
  /** Stripe's constrained refund reason enum (NOT the merchant's free-text note). */
  reason?: Stripe.RefundCreateParams.Reason;
  /** Stable key so a retry returns the same refund instead of double-refunding. */
  idempotencyKey: string;
}

export interface StripeRefundResult {
  refundId: string;
  status: string | null;
  /** ch_... the refund was applied to, when Stripe returns it. */
  chargeId: string | null;
}

export async function createStripeRefund(input: StripeRefundInput): Promise<StripeRefundResult> {
  if (!input.paymentIntentId) throw new Error("paymentIntentId is required");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error(`refund amountCents must be a positive integer, got ${input.amountCents}`);
  }
  const params: Stripe.RefundCreateParams = {
    payment_intent: input.paymentIntentId,
    amount: input.amountCents,
    reason: input.reason ?? "requested_by_customer",
    // Reverse the connected-account transfer + our platform fee only when the charge was routed
    // to a connected account; a plain platform charge takes neither param.
    ...(input.stripeAccountId ? { reverse_transfer: true, refund_application_fee: true } : {}),
  };
  const refund = await getStripe().refunds.create(params, { idempotencyKey: input.idempotencyKey });
  const chargeId =
    typeof refund.charge === "string" ? refund.charge : (refund.charge?.id ?? null);
  return { refundId: refund.id, status: refund.status ?? null, chargeId };
}
