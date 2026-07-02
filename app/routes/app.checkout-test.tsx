import { data, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Page, Card, Button, Banner, BlockStack } from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { resolveShopId } from "~/lib/supabase.server";
import { createPaymentIntent } from "~/lib/payments/stripe.server";

// Loaders are read-only (repo convention): expose only the client-safe publishable key.
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  // Test-only harness: never reachable in production so it cannot write test PIs to live data.
  if (process.env.NODE_ENV === "production") throw new Response("Not Found", { status: 404 });
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) throw new Error("STRIPE_PUBLISHABLE_KEY is not configured");
  return data({ publishableKey });
}

// Mutation: create the PaymentIntent (persists a payment_intent row) and return its client secret.
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  // Test-mode checkout resolves shop_id from the embedded-admin session; the
  // buyer-facing checkout will resolve the shop from the storefront host instead.
  const shopId = await resolveShopId(session.shop);
  // Fixed test amount ($25.00); the production checkout reads the amount from the order.
  const { clientSecret } = await createPaymentIntent(shopId, 2500, "usd");
  return data({ clientSecret });
}

function CheckoutForm() {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onPay() {
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    // redirect: "if_required" keeps test-card (4242...) flow on-page; no return_url / window.* needed.
    const { error: payError } = await stripe.confirmPayment({ elements, redirect: "if_required" });
    if (payError) setError(payError.message ?? "Payment failed");
    setSubmitting(false);
  }

  return (
    <BlockStack gap="400">
      <PaymentElement />
      {error ? <Banner tone="critical">{error}</Banner> : null}
      <Button variant="primary" loading={submitting} onClick={onPay}>
        Pay $25.00 (test)
      </Button>
    </BlockStack>
  );
}

export default function CheckoutTest() {
  const { publishableKey } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [stripePromise] = useState(() => loadStripe(publishableKey));
  const clientSecret = fetcher.data?.clientSecret;

  return (
    <Page title="Test checkout (Stripe)">
      <Card>
        {!clientSecret ? (
          <fetcher.Form method="post">
            <Button submit variant="primary" loading={fetcher.state !== "idle"}>
              Start test payment
            </Button>
          </fetcher.Form>
        ) : (
          <Elements stripe={stripePromise} options={{ clientSecret }}>
            <CheckoutForm />
          </Elements>
        )}
      </Card>
    </Page>
  );
}
