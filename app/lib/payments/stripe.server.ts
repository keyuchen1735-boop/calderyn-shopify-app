import Stripe from "stripe";
import { getSupabase } from "~/lib/supabase.server";

let _stripe: Stripe | null = null;

/** Server-only Stripe SDK singleton. Carries the secret key — never import this module client-side. */
export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  // ponytail: SDK pins its own apiVersion default; pin explicitly when the flow stabilizes.
  _stripe = new Stripe(key);
  return _stripe;
}

const KNOWN_CURRENCIES = new Set(["usd", "eur", "gbp", "cad", "aud"]);

/**
 * Create a Stripe PaymentIntent and persist the shop-scoped payment_intent row.
 * shopId leads because the warehouse has no RLS to infer the tenant on the
 * service-role write path. Returns the client secret for the Payment Element.
 */
export async function createPaymentIntent(
  shopId: string,
  amountCents: number,
  currency: string,
  orderRef?: string,
): Promise<{ paymentIntentId: string; clientSecret: string; amountCents: number; currency: string }> {
  if (!shopId) throw new Error("shopId is required");
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`amountCents must be a positive integer, got ${amountCents}`);
  }
  const cur = currency.toLowerCase();
  if (!KNOWN_CURRENCIES.has(cur)) {
    throw new Error(`unsupported currency: ${currency}`);
  }

  const pi = await getStripe().paymentIntents.create({
    amount: amountCents,
    currency: cur,
    automatic_payment_methods: { enabled: true },
    metadata: { shop_id: shopId, order_ref: orderRef ?? "" },
  });
  if (!pi.client_secret) {
    throw new Error(`Stripe PaymentIntent ${pi.id} returned no client_secret`);
  }

  const { error } = await getSupabase().from("payment_intent").insert({
    shop_id: shopId,
    stripe_pi_id: pi.id,
    order_ref: orderRef ?? null,
    amount_cents: amountCents,
    currency: cur,
    status: pi.status,
  });
  if (error) throw error;

  return {
    paymentIntentId: pi.id,
    clientSecret: pi.client_secret,
    amountCents,
    currency: cur,
  };
}

/**
 * Verify + idempotently process a Stripe webhook event over the RAW request body.
 * Returns the HTTP status the route should send plus whether this was a first
 * delivery (processed) or a duplicate (no-op). Writes nothing on bad/missing signature.
 */
export async function processStripeEvent(
  rawBody: string,
  signature: string | null,
): Promise<{ status: number; processed: boolean; duplicate: boolean }> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  if (!signature) {
    return { status: 400, processed: false, duplicate: false };
  }

  // Signature verification via the SDK over raw bytes — never hand-rolled.
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    return { status: 400, processed: false, duplicate: false };
  }

  // Only money-moving / status events touch the DB; ack everything else so Stripe stops retrying.
  if (event.type !== "payment_intent.succeeded" && event.type !== "payment_intent.payment_failed") {
    return { status: 200, processed: false, duplicate: false };
  }

  const pi = event.data.object as Stripe.PaymentIntent;
  const shopId = pi.metadata?.shop_id;
  if (!shopId) {
    // Fail visibly (rule 12): an event we can't tie to a tenant must not be silently dropped.
    throw new Error(`Stripe event ${event.id} has no shop_id in PaymentIntent metadata`);
  }

  const succeeded = event.type === "payment_intent.succeeded";
  const stripeRef =
    typeof pi.latest_charge === "string" && pi.latest_charge ? pi.latest_charge : pi.id;

  const { data, error } = await getSupabase().rpc("record_stripe_event", {
    p_event_id: event.id,
    p_type: event.type,
    p_shop_id: shopId,
    p_signature_verified: true,
    p_payload: event as unknown as Record<string, unknown>,
    p_stripe_pi_id: pi.id,
    p_new_status: succeeded ? "succeeded" : "failed",
    p_kind: succeeded ? "capture" : null,
    p_amount_cents: succeeded ? pi.amount_received : null,
    p_currency: pi.currency,
    p_stripe_ref: stripeRef,
    p_occurred_at: new Date(event.created * 1000).toISOString(),
  });
  if (error) throw error;

  const processed = data === true; // true = first delivery, false = duplicate no-op
  if (processed && succeeded) {
    // ponytail: STUBBED order step — no order table until #2. Upgrade: real order.state='paid' via #2's adapter.
    console.info(`[stripe] would set order ${pi.metadata?.order_ref || "(none)"} to paid for PI ${pi.id}`);
  }
  return { status: 200, processed, duplicate: !processed };
}
