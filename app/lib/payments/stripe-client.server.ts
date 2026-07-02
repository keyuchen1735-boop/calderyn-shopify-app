import Stripe from "stripe";

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
