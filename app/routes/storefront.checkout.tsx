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
import { paymentsReadiness } from "~/lib/payments/connect.server";
import { PaymentsNotReadyError } from "~/lib/payments/errors";
import { ShipRestrictedError, ShippingOptionUnavailableError } from "~/lib/shipping/errors";
import { OriginNotConfiguredError } from "~/lib/commerce/errors";
import { RateSourceNotConfiguredError } from "~/lib/commerce/rate-source.server";
import { quoteCartOptions } from "~/lib/commerce/quote.server";
import type { CartShippingOption } from "~/lib/commerce/types";
import { COUNTRIES, isKnownCountry } from "~/lib/storefront/countries";
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
// UI is a code-valued <select>, but a hand-crafted POST or aggressive autofill can still send a
// full country name or a bogus code, which Stripe Tax rejects deep in createCheckout ->
// quoteCart -> calculateTax, surfacing as an opaque 502 the buyer hits on every retry.
// Normalise at the action boundary against the SAME country list the select renders: a known
// 2-letter code passes, a full display name (or common alias) maps to its code, anything else
// is rejected with a friendly 400 BEFORE any Stripe call.
const COUNTRY_ALIASES: Record<string, string> = {
  usa: "US",
  "united states of america": "US",
  uk: "GB",
  "great britain": "GB",
};
const COUNTRY_BY_NAME = new Map<string, string>(
  COUNTRIES.map((c) => [c.name.toLowerCase(), c.code]),
);
function toIsoCountry(raw: string): string | null {
  const v = raw.trim();
  if (/^[A-Za-z]{2}$/.test(v)) {
    const code = v.toUpperCase();
    return isKnownCountry(code) ? code : null;
  }
  return COUNTRY_BY_NAME.get(v.toLowerCase()) ?? COUNTRY_ALIASES[v.toLowerCase()] ?? null;
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

  // Independent reads: the experiment lookup (checkout always participates, so
  // the funnel's checkout_start rows carry the arm stamp) rides alongside the
  // cart pricing instead of adding latency in front of it.
  const [priced, served] = await Promise.all([
    priceCart(shopId, cartId),
    resolveServedExperiment(shopId, request, "checkout"),
  ]);
  if (priced.lines.length === 0) return redirect("/storefront/cart");

  // A store without payment keys renders an honest "payments not set up" notice
  // instead of a 500 — the buyer keeps their cart and the storefront stays usable.
  // Still LOUD for operators: a checkout reached without keys is lost revenue.
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY ?? null;
  if (!publishableKey) {
    console.error(`[checkout] STRIPE_PUBLISHABLE_KEY is not configured; refusing checkout for shop ${shopId}`);
  }

  // Same honest state when THIS merchant can't accept payments yet (no fully-enabled
  // Stripe connected account; demo shops are exempt) — the charge path fails closed
  // (PaymentsNotReadyError) so buyer money can never settle outside the merchant's
  // account, and the buyer sees it before typing their details rather than at Pay.
  // A readiness read error also refuses (fail closed), loudly, without 500ing the
  // page — logged with its OWN cause so an operator isn't sent chasing onboarding
  // when the refusal was a DB blip. Independent of the tracking/prefill reads, so
  // all three run concurrently (this is the conversion-critical first paint).
  // checkout_start carries the experiment arm stamp (checkout always participates,
  // so the funnel's per-arm counts include this step).
  const [paymentsReady, track, prefill] = await Promise.all([
    paymentsReadiness(shopId).then(
      (r) => {
        if (!r.ready) {
          console.error(`[checkout] shop ${shopId} has no fully-enabled Stripe account; refusing checkout (lost revenue)`);
        }
        return r.ready;
      },
      (err) => {
        console.error(`[checkout] payments-readiness lookup failed for shop ${shopId}; refusing checkout:`, err);
        return false;
      },
    ),
    trackStorefrontEvent(request, shopId, "checkout_start", {
      experimentId: served.experimentId,
      variantKey: served.variantKey,
    }),
    // Prefill from the buyer's saved profile when signed in (#1b); guest checkout is unchanged.
    buyerCheckoutPrefill(request, shopId),
  ]);

  // Pre-address view: only the subtotal is known here. Shipping + tax are quoted in the action
  // once the buyer's address is captured (createCheckout), and the real total is returned then.
  return json(
    {
      publishableKey,
      paymentsReady,
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

/**
 * Buyer-actionable copy for a destination-restricted cart: name the blocked items
 * (best-effort — a pricing hiccup degrades to a count-free message) and the country
 * by display name, so the buyer knows exactly what to remove or change.
 */
async function shipRestrictedMessage(
  shopId: string,
  cartId: string,
  err: ShipRestrictedError,
): Promise<string> {
  let titles: string[] = [];
  try {
    const priced = await priceCart(shopId, cartId);
    const blocked = new Set(err.variantIds);
    titles = priced.lines.filter((l) => blocked.has(l.variantId)).map((l) => l.titleSnapshot);
  } catch (priceErr) {
    console.error(`[checkout] could not resolve blocked-item titles for cart ${cartId} (shop ${shopId}):`, priceErr);
    titles = [];
  }
  const countryName =
    COUNTRIES.find((c) => c.code === err.destinationCountry.toUpperCase())?.name ??
    err.destinationCountry;
  if (titles.length === 0) {
    return `Some items in your cart can't be shipped to ${countryName}. Please remove them or use a different address.`;
  }
  const pronoun = titles.length === 1 ? "it" : "them";
  return `${titles.join(", ")} can't be shipped to ${countryName}. Please remove ${pronoun} from your cart or use a different address.`;
}

/**
 * Shared mapping of typed quote-path errors to buyer-facing responses — used by BOTH
 * the options step and the pay step so their copy and status codes can never drift.
 * Returns null for errors the caller maps itself (or the generic fallback).
 */
async function mapShippingError(
  err: unknown,
  shopId: string,
  cartId: string,
): Promise<Response | null> {
  // Destination-restricted items: actionable — name the items so the buyer knows
  // exactly what to remove or that a different address would work.
  if (err instanceof ShipRestrictedError) {
    return json({ error: await shipRestrictedMessage(shopId, cartId, err) }, { status: 422 });
  }
  // The merchant hasn't set a ship-from address / any rate config the promise path
  // trusts. Retrying can't help the buyer; say so honestly.
  if (err instanceof OriginNotConfiguredError || err instanceof RateSourceNotConfiguredError) {
    console.error(`[checkout] shop ${shopId} cannot quote shipping; refused (lost revenue):`, err);
    return json(
      { error: "This store can't ship orders yet. Your cart is saved — please check back soon." },
      { status: 503 },
    );
  }
  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  if (shopId === DEMO_SHOP_ID) return redirect("/storefront/cart");
  const cartId = await readCartId(request);
  if (!cartId) return redirect("/storefront/cart");

  // Each submission quotes live carrier rates and (on pay) mints a Stripe
  // PaymentIntent, so throttle per-IP and per-cart to blunt card-testing and cost
  // abuse. A normal checkout is now two POSTs (quote options, then pay), and every
  // address correction burns an extra quote POST, so the per-cart hourly budget is
  // sized for ~10 full attempts with edits — the old single-POST flow's allowance.
  if (
    !(await rateLimit(clientIpKey(request, "sf-checkout"), 8, 60_000)) ||
    !(await rateLimit(`sf-checkout:${cartId}`, 30, 3_600_000))
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
  // Stripe Tax and 502 the buyer. The UI is a code-valued <select>, so this only fires on a
  // hand-crafted POST. countryIso is what flows into the quote/checkout from here on.
  const countryIso = toIsoCountry(country);
  if (!countryIso) {
    return json(
      { error: "Please choose a country from the list." },
      { status: 400 },
    );
  }

  // Step 1 of 2: quote the shipping options for this address — no consent needed yet,
  // no DB write, no PaymentIntent. The buyer picks an option, then posts intent=pay.
  const intent = str(form, "intent") || "pay";
  if (intent === "quote") {
    try {
      const priced = await priceCart(shopId, cartId);
      if (priced.lines.length === 0) return redirect("/storefront/cart");
      const { options, currency } = await quoteCartOptions(
        shopId,
        priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
        {
          street1: line1,
          street2: line2 || undefined,
          city,
          state: region,
          zip: postal,
          country: countryIso,
        },
        { subtotalCentsOverride: priced.subtotalCents },
      );
      return json({ shippingOptions: options, optionsCurrency: currency });
    } catch (err) {
      const mapped = await mapShippingError(err, shopId, cartId);
      if (mapped) return mapped;
      console.error(`[checkout] shipping options failed for shop ${shopId}, cart ${cartId}:`, err);
      return json(
        { error: "We couldn't get shipping options for that address. Please check it and try again." },
        { status: 502 },
      );
    }
  }

  // Step 2 of 2: pay. Consent is mandatory and must be EXPLICIT — reject (fail visibly) if not
  // accepted, never silently proceed (the buyer helper records tos/privacy as accepted=true
  // unconditionally, so the gate is here at the boundary).
  if (!tosAccepted || !privacyAccepted) {
    return json(
      { error: "You must accept the Terms of Service and Privacy Policy to place an order." },
      { status: 400 },
    );
  }
  const shippingService = str(form, "shippingService") || null;

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
      { shippingService },
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
        shippingService: result.shippingService,
        deliveryEarliest: result.deliveryEarliest,
        deliveryLatest: result.deliveryLatest,
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
    // The shop can't accept payments (no fully-enabled Stripe account). createCheckout fails
    // closed before any charge; tell the buyer honestly instead of an opaque retry loop.
    if (err instanceof PaymentsNotReadyError) {
      console.error(`[checkout] shop ${shopId} not payment-ready; checkout refused (lost revenue)`);
      return json(
        { error: "This store isn't accepting payments yet. Your cart is saved — please check back soon." },
        { status: 503 },
      );
    }
    // The buyer's chosen rate vanished between the options step and pay (carrier drift).
    // The error response replaces the fetched options, so the UI lands back on the
    // address step — the copy matches that: continue again for fresh options.
    if (err instanceof ShippingOptionUnavailableError) {
      return json(
        {
          error:
            "That shipping option just changed. Please continue to shipping again and pick from the updated options.",
        },
        { status: 409 },
      );
    }
    const mapped = await mapShippingError(err, shopId, cartId);
    if (mapped) return mapped;
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

// "Arrives Jul 14–16" from the quote's ISO calendar dates. Locale + UTC pinned so
// SSR/hydration and every buyer timezone render the promised dates identically.
function fmtArrival(earliest: string | null, latest: string | null): string | null {
  if (!earliest) return null;
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const e = new Date(earliest);
  if (Number.isNaN(e.getTime())) return null;
  const eTxt = fmt.format(e);
  if (!latest || latest === earliest) return `Arrives ${eTxt}`;
  const l = new Date(latest);
  if (Number.isNaN(l.getTime())) return `Arrives ${eTxt}`;
  return `Arrives ${eTxt}–${fmt.format(l)}`;
}

export default function StorefrontCheckout() {
  const { publishableKey, paymentsReady, origin, summary, prefill } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [stripePromise] = useState(() => (publishableKey ? loadStripe(publishableKey) : null));
  // Buyer stepped back to edit the address after seeing options; cleared again on submit.
  const [editingAddress, setEditingAddress] = useState(false);

  const data = fetcher.data;
  const clientSecret = data && "clientSecret" in data ? data.clientSecret : undefined;
  const confirmationToken = data && "confirmationToken" in data ? data.confirmationToken : undefined;
  const formError = data && "error" in data ? data.error : undefined;
  const shippingOptions: CartShippingOption[] | undefined =
    data && "shippingOptions" in data ? data.shippingOptions : undefined;
  // Once the action has quoted shipping + tax, show the real charged amounts; before that only
  // the subtotal is known.
  const charged = data && "totalCents" in data ? data : null;
  const total = charged
    ? money(charged.totalCents, charged.currency)
    : money(summary.subtotalCents, summary.currency);
  const chargedArrival = charged ? fmtArrival(charged.deliveryEarliest, charged.deliveryLatest) : null;

  // Which half of the single form is visible. Address inputs stay MOUNTED (hidden)
  // on the options step so the pay submit re-posts the address the options were
  // quoted for; consent renders only on the options step (a hidden required
  // checkbox would block the quote submit).
  const onOptionsStep = !!shippingOptions && shippingOptions.length > 0 && !editingAddress;
  const busy = fetcher.state !== "idle";

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
              <span>
                Shipping
                {charged.shippingService ? ` (${charged.shippingService})` : ""}
              </span>
              <span>
                {charged.shippingCents === 0 ? "Free" : money(charged.shippingCents, charged.currency)}
              </span>
            </div>
            {chargedArrival ? (
              <div className="cd-checkout__row">
                <span>{chargedArrival}</span>
                <span />
              </div>
            ) : null}
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

      {!publishableKey || !paymentsReady ? (
        <p className="cd-checkout__error">
          This store isn&apos;t accepting payments yet. Your cart is saved — please check back soon.
        </p>
      ) : !clientSecret ? (
        <fetcher.Form
          method="post"
          className="cd-checkout__form"
          onSubmit={() => setEditingAddress(false)}
        >
          <div hidden={onOptionsStep}>
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
              <span>Country</span>
              <select name="country" autoComplete="country" defaultValue={prefill?.country || "US"} required>
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="cd-checkout__field">
              <span>Phone (optional)</span>
              <input type="tel" name="phone" autoComplete="tel" defaultValue={prefill?.phone} />
            </label>
          </div>

          {onOptionsStep && shippingOptions ? (
            <div className="cd-checkout__shipping">
              <h2>Shipping method</h2>
              {shippingOptions.map((o, i) => {
                const arrival = fmtArrival(o.deliveryEarliest, o.deliveryLatest);
                return (
                  <label key={o.service} className="cd-checkout__option">
                    <input type="radio" name="shippingService" value={o.service} defaultChecked={i === 0} />
                    <span className="cd-checkout__option-label">
                      <span className="cd-checkout__option-name">{o.label}</span>
                      {arrival ? <span className="cd-checkout__option-arrival">{arrival}</span> : null}
                    </span>
                    <span className="cd-checkout__option-price">
                      {o.amountCents === 0 ? "Free" : money(o.amountCents, summary.currency)}
                    </span>
                  </label>
                );
              })}
              <button
                type="button"
                className="cd-checkout__back"
                onClick={() => setEditingAddress(true)}
              >
                Edit address
              </button>

              <label className="cd-checkout__consent">
                <input type="checkbox" name="tos" required /> <span>I accept the Terms of Service.</span>
              </label>
              <label className="cd-checkout__consent">
                <input type="checkbox" name="privacy" required />{" "}
                <span>I accept the Privacy Policy.</span>
              </label>
              <label className="cd-checkout__consent">
                <input type="checkbox" name="marketing" />{" "}
                <span>Send me occasional product updates (optional).</span>
              </label>
            </div>
          ) : null}

          {formError ? <p className="cd-checkout__error">{formError}</p> : null}
          {onOptionsStep ? (
            <button
              type="submit"
              name="intent"
              value="pay"
              className="cd-checkout__submit"
              disabled={busy}
            >
              {busy ? "Starting…" : "Continue to payment"}
            </button>
          ) : (
            <button
              type="submit"
              name="intent"
              value="quote"
              className="cd-checkout__submit"
              disabled={busy}
            >
              {busy ? "Checking rates…" : "Continue to shipping"}
            </button>
          )}
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
