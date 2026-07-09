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
import { resolveStorefrontShop, DEMO_SHOP_ID } from "~/lib/storefront/shop.server";
import { readCartId } from "~/lib/storefront/cart-cookie.server";
import { trackStorefrontEvent } from "~/lib/storefront/events.server";
import { ensureVisitorSession } from "~/lib/storefront/visitor-cookie.server";
import { resolveServedExperiment } from "~/lib/experiments/store-experiment.server";
import { priceCart } from "~/lib/order/cart.server";
import { createCheckout, OutOfStockError } from "~/lib/order/checkout.server";
import { rateLimit, clientIpKey } from "~/lib/rate-limit.server";
import { getBuyerSession } from "~/lib/buyer/session.server";
import { defaultShippingAddress, getBuyerEmail } from "~/lib/buyer/account.server";
import { formatMoney as money } from "~/lib/storefront/money";
import { storeNameFromMatches } from "~/lib/storefront/meta";

interface CheckoutPrefill {
  email: string;
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postal: string;
  country: string;
  phone: string;
}

/**
 * Prefill the checkout form for a SIGNED-IN buyer from their saved email + default shipping
 * address (#1b). Best-effort and fails OPEN: a buyer-session/DB hiccup must never break checkout,
 * so any error yields no prefill rather than a 500. Guest checkout (no buyer session) is unchanged.
 */
async function buyerCheckoutPrefill(request: Request, shopId: string): Promise<CheckoutPrefill | null> {
  try {
    const session = await getBuyerSession(request, shopId);
    if (!session) return null;
    const [email, addr] = await Promise.all([
      getBuyerEmail(shopId, session.buyerId),
      defaultShippingAddress(shopId, session.buyerId),
    ]);
    return {
      email: email ?? "",
      name: addr?.name ?? "",
      line1: addr?.line1 ?? "",
      line2: addr?.line2 ?? "",
      city: addr?.city ?? "",
      region: addr?.region ?? "",
      postal: addr?.postal ?? "",
      country: addr?.country ?? "",
      phone: addr?.phone ?? "",
    };
  } catch (err) {
    console.error(`[checkout] buyer prefill failed for shop ${shopId} (continuing as guest):`, err);
    return null;
  }
}

/**
 * Stamp {experiment_id, variant_key} onto the order's attribution when an A/B test is
 * running (D4) — snake_case to match the keys experimentReport reads back off
 * orders.attribution. The shared resolver buckets off the COOKIE visitor id, the same id
 * every storefront surface bucketed with — a buyer whose cookie vanished between browse
 * and checkout gets NO stamp rather than a freshly-minted id's 50/50 coin flip crediting
 * the wrong arm. Failure-isolated inside the resolver: the order still records
 * live_session_id when the lookup hiccups.
 */
async function checkoutExperimentAttribution(
  shopId: string,
  request: Request,
): Promise<Record<string, string>> {
  const served = await resolveServedExperiment(shopId, request, "checkout");
  if (!served.experimentId || !served.variantKey) return {};
  return { experiment_id: served.experimentId, variant_key: served.variantKey };
}

// The policy text version the buyer accepts at checkout — recorded verbatim on buyer_consent as
// the proof of WHICH ToS/privacy text was accepted (#1). Bump when the policy text changes.
const CHECKOUT_POLICY_VERSION = "2026-06-29";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Stripe Tax + the shipping-rate engine require an ISO 3166-1 alpha-2 country (e.g. "US"). The
// free-text field lets a browser autofill a full country name, which Stripe Tax rejects deep in
// createCheckout -> quoteCart -> calculateTax, surfacing as an opaque 502 the buyer hits on every
// retry. Normalise at the action boundary: accept a 2-letter code directly, or map a few common
// full names; anything else is rejected with a friendly 400 BEFORE any Stripe call.
const COUNTRY_ALIASES: Record<string, string> = {
  "united states": "US",
  usa: "US",
  "united kingdom": "GB",
  uk: "GB",
  canada: "CA",
};
function toIsoCountry(raw: string): string | null {
  const v = raw.trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  return COUNTRY_ALIASES[v.toLowerCase()] ?? null;
}

export const meta: MetaFunction = ({ matches }) => {
  const title = `Checkout — ${storeNameFromMatches(matches)}`;
  return [
    { title },
    { name: "description", content: "Complete your order." },
    { name: "robots", content: "noindex" },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  // Demo shell is browse-only — no cart can exist for it (see storefront.cart.tsx).
  if (shopId === DEMO_SHOP_ID) return redirect("/storefront/cart");
  const cartId = await readCartId(request);
  // No cart -> nothing to check out; send the buyer back to the cart view.
  if (!cartId) return redirect("/storefront/cart");

  const priced = await priceCart(shopId, cartId);
  if (priced.lines.length === 0) return redirect("/storefront/cart");

  // A store without payment keys renders an honest "payments not set up" notice
  // instead of a 500 — the buyer keeps their cart and the storefront stays usable.
  // Still LOUD for operators: a checkout reached without keys is lost revenue.
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY ?? null;
  if (!publishableKey) {
    console.error(`[checkout] STRIPE_PUBLISHABLE_KEY is not configured; refusing checkout for shop ${shopId}`);
  }

  const track = await trackStorefrontEvent(request, shopId, "checkout_start");

  // Prefill from the buyer's saved profile when signed in (#1b); guest checkout is unchanged.
  const prefill = await buyerCheckoutPrefill(request, shopId);

  // Pre-address view: only the subtotal is known here. Shipping + tax are quoted in the action
  // once the buyer's address is captured (createCheckout), and the real total is returned then.
  return json(
    {
      publishableKey,
      origin: new URL(request.url).origin,
      prefill,
      summary: {
        lines: priced.lines.map((l) => ({
          id: l.id,
          title: l.titleSnapshot,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
        })),
        subtotalCents: priced.subtotalCents,
        currency: priced.currency,
      },
    },
    { headers: track },
  );
}

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function action({ request }: ActionFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  if (shopId === DEMO_SHOP_ID) return redirect("/storefront/cart");
  const cartId = await readCartId(request);
  if (!cartId) return redirect("/storefront/cart");

  // Each submission quotes live carrier rates and mints a Stripe PaymentIntent,
  // so throttle per-IP and per-cart to blunt card-testing and cost abuse.
  if (
    !(await rateLimit(clientIpKey(request, "sf-checkout"), 5, 60_000)) ||
    !(await rateLimit(`sf-checkout:${cartId}`, 10, 3_600_000))
  ) {
    return json(
      { error: "Too many checkout attempts. Please wait a moment and try again." },
      { status: 429 },
    );
  }

  // Mirror the loader's posture: without the publishable key the Payment Element
  // can never render, so refuse up front instead of failing mid-flow inside
  // Stripe. (A missing secret key still surfaces via the 502 catch below.)
  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    console.error(`[checkout] STRIPE_PUBLISHABLE_KEY is not configured; refusing checkout action for shop ${shopId}`);
    return json(
      { error: "This store isn't accepting payments yet. Please check back soon." },
      { status: 503 },
    );
  }

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
  const line2 = str(form, "line2");
  const phone = str(form, "phone");

  // Bound every free-text field so a public POST can't store oversized PII or bloat rows.
  const FIELD_MAX = 500;
  if ([email, name, line1, line2, city, region, postal, country, phone].some((v) => v.length > FIELD_MAX)) {
    return json({ error: "One of your details is too long. Please shorten it and try again." }, { status: 400 });
  }

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
  // Reject a non-ISO country here (fail visibly, rule 12) so a full-name autofill can never reach
  // Stripe Tax and 502 the buyer. countryIso is what flows into createCheckout from here on.
  const countryIso = toIsoCountry(country);
  if (!countryIso) {
    return json(
      { error: "Please enter a valid country as a two-letter code, e.g. US." },
      { status: 400 },
    );
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

  // Originating a checkout reaches Stripe + the DB; a transient failure must surface inline
  // (rule 12) rather than throwing a 500 that discards the buyer's just-entered contact + shipping
  // details. Validation errors above already 400; this catches the money/network path.
  // Stamp the live-analytics session onto the order's attribution snapshot.
  // The paid flip happens in the Stripe webhook (no browser cookies there), so
  // this is the only moment the session id and the order meet — it anchors the
  // Live View funnel's "purchased" count on paid orders instead of on the
  // buyer happening to revisit the confirmation page.
  // Independent reads — resolved concurrently so the experiment lookup never adds latency
  // in front of createCheckout, the most conversion-sensitive call in the app.
  const [visitor, experimentAttribution] = await Promise.all([
    ensureVisitorSession(request),
    checkoutExperimentAttribution(shopId, request),
  ]);

  try {
    const result = await createCheckout(
      shopId,
      cartId,
      {
        email,
        address: {
          kind: "shipping",
          name,
          line1,
          line2: line2 || null,
          city,
          region,
          postal,
          country: countryIso,
          phone: phone || null,
          isDefault: true,
        },
        consent: { version: CHECKOUT_POLICY_VERSION, marketingOptIn, sourceIp, ua },
      },
      { live_session_id: visitor.sessionId, ...experimentAttribution },
    );

    // Return the client secret + confirmation token AND the amounts actually charged (subtotal +
    // quoted shipping + tax) so the payment step shows the real total, not the subtotal-only figure.
    // The cart is NOT cleared here — payment can still fail at the Payment Element; the cart is
    // cleared on the confirmation page. The visitor Set-Cookie headers ride along so a session
    // minted here persists into the confirmation page's checkout_complete event.
    return json(
      {
        clientSecret: result.clientSecret,
        confirmationToken: result.confirmationToken,
        subtotalCents: result.subtotalCents,
        shippingCents: result.shippingCents,
        taxCents: result.taxCents,
        totalCents: result.totalCents,
        currency: result.currency,
      },
      { headers: visitor.headers },
    );
  } catch (err) {
    // One or more items sold out between add-to-cart and checkout: surface an actionable 409 so
    // the buyer knows to remove the sold-out line, rather than an opaque "try again" 502 they'd
    // hit forever. The order was already cancelled + holds released inside createCheckout.
    if (err instanceof OutOfStockError) {
      return json(
        { error: "One or more items in your cart just sold out. Please remove them and try again." },
        { status: 409 },
      );
    }
    console.error(`[checkout] failed to originate checkout for shop ${shopId}, cart ${cartId}:`, err);
    return json({ error: "We couldn't start your payment. Please try again." }, { status: 502 });
  }
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
    // confirmPayment only resolves HERE on an immediate error — a success redirects the browser
    // to return_url. Set an error message ONLY when one is present: a resolve without an error
    // must not flash a spurious "Payment failed" (and re-arm the pay button into a double-charge).
    if (payError) setError(payError.message ?? "Payment failed. Please try again.");
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
  const { publishableKey, origin, summary, prefill } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [stripePromise] = useState(() => (publishableKey ? loadStripe(publishableKey) : null));

  const data = fetcher.data;
  const clientSecret = data && "clientSecret" in data ? data.clientSecret : undefined;
  const confirmationToken = data && "confirmationToken" in data ? data.confirmationToken : undefined;
  const formError = data && "error" in data ? data.error : undefined;
  // Once the action has quoted shipping + tax, show the real charged amounts; before that only
  // the subtotal is known.
  const charged = data && "totalCents" in data ? data : null;
  const total = charged
    ? money(charged.totalCents, charged.currency)
    : money(summary.subtotalCents, summary.currency);

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
        {charged ? (
          <>
            <div className="cd-checkout__row">
              <span>Subtotal</span>
              <span>{money(charged.subtotalCents, charged.currency)}</span>
            </div>
            <div className="cd-checkout__row">
              <span>Shipping</span>
              <span>{money(charged.shippingCents, charged.currency)}</span>
            </div>
            <div className="cd-checkout__row">
              <span>Tax</span>
              <span>{money(charged.taxCents, charged.currency)}</span>
            </div>
            <div className="cd-checkout__total">
              <span>Total</span>
              <span>{total}</span>
            </div>
          </>
        ) : (
          <div className="cd-checkout__total">
            <span>Subtotal</span>
            <span>{money(summary.subtotalCents, summary.currency)}</span>
          </div>
        )}
      </div>

      {!publishableKey ? (
        <p className="cd-checkout__error">
          This store isn&apos;t accepting payments yet. Your cart is saved — please check back soon.
        </p>
      ) : !clientSecret ? (
        <fetcher.Form method="post" className="cd-checkout__form">
          {prefill ? (
            <p className="cd-checkout__signedin">Using your saved details — edit any field below if needed.</p>
          ) : null}
          <h2>Contact</h2>
          <label className="cd-checkout__field">
            <span>Email</span>
            <input type="email" name="email" autoComplete="email" defaultValue={prefill?.email} required />
          </label>

          <h2>Shipping address</h2>
          <label className="cd-checkout__field">
            <span>Full name</span>
            <input type="text" name="name" autoComplete="name" defaultValue={prefill?.name} required />
          </label>
          <label className="cd-checkout__field">
            <span>Address</span>
            <input type="text" name="line1" autoComplete="address-line1" defaultValue={prefill?.line1} required />
          </label>
          <label className="cd-checkout__field">
            <span>Apartment, suite, etc. (optional)</span>
            <input type="text" name="line2" autoComplete="address-line2" defaultValue={prefill?.line2} />
          </label>
          <label className="cd-checkout__field">
            <span>City</span>
            <input type="text" name="city" autoComplete="address-level2" defaultValue={prefill?.city} required />
          </label>
          <label className="cd-checkout__field">
            <span>State / region</span>
            <input type="text" name="region" autoComplete="address-level1" defaultValue={prefill?.region} required />
          </label>
          <label className="cd-checkout__field">
            <span>Postal code</span>
            <input type="text" name="postal" autoComplete="postal-code" defaultValue={prefill?.postal} required />
          </label>
          <label className="cd-checkout__field">
            <span>Country (2-letter code, e.g. US)</span>
            <input
              type="text"
              name="country"
              autoComplete="country"
              maxLength={2}
              placeholder="US"
              defaultValue={prefill?.country}
              required
            />
          </label>
          <label className="cd-checkout__field">
            <span>Phone (optional)</span>
            <input type="tel" name="phone" autoComplete="tel" defaultValue={prefill?.phone} />
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
