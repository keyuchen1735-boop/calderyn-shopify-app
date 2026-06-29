// app/routes/storefront.checkout.tsx
// Buyer checkout (platform pivot #2c-2). Handles PII (email + shipping address + consent) and
// payment. PII is posted to OUR action (server) over the form; CARD DATA goes only to Stripe.js
// (the Payment Element), never to our server. The loader exposes only the Stripe PUBLISHABLE key
// — the secret stays server-side (lib/payments/stripe.server.ts).
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { readCartId } from "~/lib/storefront/cart-cookie.server";
import { priceCart } from "~/lib/order/cart.server";
import { createCheckout } from "~/lib/order/checkout.server";

// The policy text version the buyer accepts at checkout — recorded verbatim on buyer_consent as
// the proof of WHICH ToS/privacy text was accepted (#1). Bump when the policy text changes.
const CHECKOUT_POLICY_VERSION = "2026-06-29";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const meta: MetaFunction = () => {
  const title = "Checkout — Calderyn Demo Store";
  return [
    { title },
    { name: "description", content: "Complete your order." },
    { name: "robots", content: "noindex" },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const cartId = await readCartId(request);
  // No cart -> nothing to check out; send the buyer back to the cart view.
  if (!cartId) return redirect("/storefront/cart");

  const priced = await priceCart(shopId, cartId);
  if (priced.lines.length === 0) return redirect("/storefront/cart");

  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) throw new Error("STRIPE_PUBLISHABLE_KEY is not configured");

  // Shipping + tax are flat-0 placeholders for the pilot (mirrors createCheckout); total == subtotal.
  return json({
    publishableKey,
    origin: new URL(request.url).origin,
    summary: {
      lines: priced.lines.map((l) => ({
        id: l.id,
        title: l.titleSnapshot,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
      })),
      totalCents: priced.subtotalCents,
      currency: priced.currency,
    },
  });
}

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function action({ request }: ActionFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const cartId = await readCartId(request);
  if (!cartId) return redirect("/storefront/cart");

  const form = await request.formData();

  // Validate at the boundary — never trust the FormData shape (rule: validate inbound form data).
  const email = str(form, "email").toLowerCase();
  const name = str(form, "name");
  const line1 = str(form, "line1");
  const city = str(form, "city");
  const region = str(form, "region");
  const postal = str(form, "postal");
  const country = str(form, "country");
  const tosAccepted = form.get("tos") === "on" || form.get("tos") === "true";
  const privacyAccepted = form.get("privacy") === "on" || form.get("privacy") === "true";
  const marketingOptIn = form.get("marketing") === "on" || form.get("marketing") === "true";

  const missing: string[] = [];
  if (!EMAIL_RE.test(email)) missing.push("a valid email");
  if (!name) missing.push("full name");
  if (!line1) missing.push("address");
  if (!city) missing.push("city");
  if (!region) missing.push("state/region");
  if (!postal) missing.push("postal code");
  if (!country) missing.push("country");
  if (missing.length > 0) {
    return json({ error: `Please provide ${missing.join(", ")}.` }, { status: 400 });
  }
  // Consent is mandatory and must be EXPLICIT — reject (fail visibly) if not accepted, never
  // silently proceed (the buyer helper records tos/privacy as accepted=true unconditionally, so
  // the gate is here at the boundary).
  if (!tosAccepted || !privacyAccepted) {
    return json(
      { error: "You must accept the Terms of Service and Privacy Policy to place an order." },
      { status: 400 },
    );
  }

  // Consent proof: WHO/WHERE accepted. x-forwarded-for's first hop is the client; fall back to
  // x-real-ip. Captured for legal proof only — never logged, never sent to the warehouse.
  const sourceIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    null;
  const ua = request.headers.get("user-agent");

  const result = await createCheckout(shopId, cartId, {
    email,
    address: {
      kind: "shipping",
      name,
      line1,
      line2: str(form, "line2") || null,
      city,
      region,
      postal,
      country,
      phone: str(form, "phone") || null,
      isDefault: true,
    },
    consent: { version: CHECKOUT_POLICY_VERSION, marketingOptIn, sourceIp, ua },
  });

  // Return the client secret + confirmation token to the page. The cart is NOT cleared here —
  // payment can still fail at the Payment Element; the cart is cleared on the confirmation page.
  return json({ clientSecret: result.clientSecret, confirmationToken: result.confirmationToken });
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

function PaymentStep({ confirmationUrl, total }: { confirmationUrl: string; total: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onPay() {
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    // Card data is collected by the Payment Element and sent ONLY to Stripe. On success Stripe
    // redirects the browser to return_url (the token-keyed confirmation page); confirmPayment only
    // resolves here on an immediate error (validation / declined card) — so no manual navigation,
    // no window.* call, is needed.
    const { error: payError } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: confirmationUrl },
    });
    setError(payError?.message ?? "Payment failed. Please try again.");
    setSubmitting(false);
  }

  return (
    <div className="cd-checkout__pay">
      <PaymentElement />
      {error ? <p className="cd-checkout__error">{error}</p> : null}
      <button
        type="button"
        className="cd-checkout__submit"
        disabled={!stripe || submitting}
        onClick={onPay}
      >
        {submitting ? "Processing…" : `Pay ${total}`}
      </button>
    </div>
  );
}

export default function StorefrontCheckout() {
  const { publishableKey, origin, summary } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [stripePromise] = useState(() => loadStripe(publishableKey));

  const data = fetcher.data;
  const clientSecret = data && "clientSecret" in data ? data.clientSecret : undefined;
  const confirmationToken = data && "confirmationToken" in data ? data.confirmationToken : undefined;
  const formError = data && "error" in data ? data.error : undefined;
  const total = money(summary.totalCents, summary.currency);

  return (
    <section className="cd-checkout">
      <h1>Checkout</h1>

      <div className="cd-checkout__summary">
        <ul className="cd-checkout__lines">
          {summary.lines.map((line) => (
            <li key={line.id} className="cd-checkout__line">
              <span className="cd-checkout__line-title">{line.title}</span>
              <span className="cd-checkout__line-qty">Qty {line.quantity}</span>
              <span className="cd-checkout__line-total">
                {money(line.unitPriceCents * line.quantity, summary.currency)}
              </span>
            </li>
          ))}
        </ul>
        <div className="cd-checkout__total">
          <span>Total</span>
          <span>{total}</span>
        </div>
      </div>

      {!clientSecret ? (
        <fetcher.Form method="post" className="cd-checkout__form">
          <h2>Contact</h2>
          <label className="cd-checkout__field">
            <span>Email</span>
            <input type="email" name="email" autoComplete="email" required />
          </label>

          <h2>Shipping address</h2>
          <label className="cd-checkout__field">
            <span>Full name</span>
            <input type="text" name="name" autoComplete="name" required />
          </label>
          <label className="cd-checkout__field">
            <span>Address</span>
            <input type="text" name="line1" autoComplete="address-line1" required />
          </label>
          <label className="cd-checkout__field">
            <span>Apartment, suite, etc. (optional)</span>
            <input type="text" name="line2" autoComplete="address-line2" />
          </label>
          <label className="cd-checkout__field">
            <span>City</span>
            <input type="text" name="city" autoComplete="address-level2" required />
          </label>
          <label className="cd-checkout__field">
            <span>State / region</span>
            <input type="text" name="region" autoComplete="address-level1" required />
          </label>
          <label className="cd-checkout__field">
            <span>Postal code</span>
            <input type="text" name="postal" autoComplete="postal-code" required />
          </label>
          <label className="cd-checkout__field">
            <span>Country</span>
            <input type="text" name="country" autoComplete="country-name" required />
          </label>
          <label className="cd-checkout__field">
            <span>Phone (optional)</span>
            <input type="tel" name="phone" autoComplete="tel" />
          </label>

          <label className="cd-checkout__consent">
            <input type="checkbox" name="tos" /> <span>I accept the Terms of Service.</span>
          </label>
          <label className="cd-checkout__consent">
            <input type="checkbox" name="privacy" /> <span>I accept the Privacy Policy.</span>
          </label>
          <label className="cd-checkout__consent">
            <input type="checkbox" name="marketing" />{" "}
            <span>Send me occasional product updates (optional).</span>
          </label>

          {formError ? <p className="cd-checkout__error">{formError}</p> : null}
          <button type="submit" className="cd-checkout__submit" disabled={fetcher.state !== "idle"}>
            {fetcher.state !== "idle" ? "Starting…" : "Continue to payment"}
          </button>
        </fetcher.Form>
      ) : (
        <Elements stripe={stripePromise} options={{ clientSecret }}>
          <PaymentStep
            confirmationUrl={`${origin}/storefront/checkout/confirmation/${confirmationToken}`}
            total={total}
          />
        </Elements>
      )}
    </section>
  );
}
