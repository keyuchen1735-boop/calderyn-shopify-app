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
