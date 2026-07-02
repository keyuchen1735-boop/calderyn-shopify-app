import type { ActionFunctionArgs } from "react-router";
import { processStripeEvent } from "~/lib/payments/stripe.server";

// Public, unauthenticated Stripe webhook. Stripe signs the request; the signature
// is verified against the RAW body inside processStripeEvent before any DB write.
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const signature = request.headers.get("stripe-signature");
  const rawBody = await request.text(); // raw bytes required for signature verification
  const result = await processStripeEvent(rawBody, signature);
  const body =
    result.status === 200 ? (result.duplicate ? "duplicate" : "ok") : "invalid signature";
  return new Response(body, { status: result.status });
}
