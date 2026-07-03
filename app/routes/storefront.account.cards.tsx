// app/routes/storefront.account.cards.tsx
// Saved cards management (platform pivot #1b). Cards are VAULTED IN STRIPE — the raw card is
// entered into Stripe's Payment Element and never touches our server; we persist only Stripe's
// display fields. Add-a-card uses a SetupIntent: the action mints the SetupIntent client secret
// (loaders stay read-only), the browser confirms it, and Stripe redirects back here with
// ?setup_intent=..., which the loader saves. List + detach let the buyer manage saved cards.
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { resolveStorefrontShop, DEMO_SHOP_ID } from "~/lib/storefront/shop.server";
import { requireBuyerSession } from "~/lib/buyer/session.server";
import { listSavedCards, detachCard, createBuyerSetupIntent, saveConfirmedCard } from "~/lib/buyer/payment-methods.server";
import { storeNameFromMatches } from "~/lib/storefront/meta";

export const meta: MetaFunction = ({ matches }) => [
  { title: `Saved cards — ${storeNameFromMatches(matches)}` },
  { name: "robots", content: "noindex" },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  if (shopId === DEMO_SHOP_ID) return redirect("/storefront");
  const { buyerId } = await requireBuyerSession(request, shopId);

  // Stripe redirects back here after the buyer confirms a SetupIntent. Persist the resulting card
  // (idempotent upsert; ownership-checked against this buyer's Customer inside saveConfirmedCard),
  // then strip the query so a refresh doesn't re-run the save. A write in a loader is deliberate
  // here — this is the Stripe return callback (same posture as the confirmation page clearing the
  // cart in its loader), and the underlying save is idempotent.
  const url = new URL(request.url);
  const setupIntentId = url.searchParams.get("setup_intent");
  if (setupIntentId) {
    await saveConfirmedCard(shopId, buyerId, setupIntentId);
    return redirect("/storefront/account/cards?saved=1");
  }

  const cards = await listSavedCards(shopId, buyerId);
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY ?? null;
  return json({
    cards,
    publishableKey,
    origin: url.origin,
    justSaved: url.searchParams.get("saved") === "1",
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  if (shopId === DEMO_SHOP_ID) return redirect("/storefront");
  const { buyerId } = await requireBuyerSession(request, shopId);

  const form = await request.formData();
  const intent = typeof form.get("intent") === "string" ? String(form.get("intent")) : "";

  if (intent === "detach") {
    const cardId = typeof form.get("cardId") === "string" ? String(form.get("cardId")) : "";
    await detachCard(shopId, buyerId, cardId);
    return redirect("/storefront/account/cards");
  }

  if (intent === "add") {
    if (!process.env.STRIPE_PUBLISHABLE_KEY) {
      return json({ error: "This store isn't set up to save cards yet." }, { status: 503 });
    }
    try {
      const { clientSecret } = await createBuyerSetupIntent(shopId, buyerId);
      return json({ clientSecret });
    } catch (err) {
      console.error(`[account-cards] failed to create SetupIntent for buyer ${buyerId} (shop ${shopId}):`, err);
      return json({ error: "We couldn't start adding a card. Please try again." }, { status: 502 });
    }
  }

  return json({ error: "Unknown action." }, { status: 400 });
}

function AddCardForm({ returnUrl }: { returnUrl: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSave() {
    if (!stripe || !elements) return;
    setSaving(true);
    setError(null);
    // Card details go ONLY to Stripe. On success Stripe redirects to return_url (?setup_intent=...);
    // confirmSetup resolves here only on an immediate error.
    const { error: setupError } = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: returnUrl },
    });
    if (setupError) setError(setupError.message ?? "We couldn't save that card. Please try again.");
    setSaving(false);
  }

  return (
    <div className="cd-account__pay">
      <PaymentElement />
      {error ? <p className="cd-account__error">{error}</p> : null}
      <button type="button" className="cd-account__submit" disabled={!stripe || saving} onClick={onSave}>
        {saving ? "Saving…" : "Save card"}
      </button>
    </div>
  );
}

export default function BuyerCards() {
  const { cards, publishableKey, origin, justSaved } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [stripePromise] = useState(() => (publishableKey ? loadStripe(publishableKey) : null));

  const data = fetcher.data;
  const clientSecret = data && "clientSecret" in data ? data.clientSecret : undefined;
  const formError = data && "error" in data ? data.error : undefined;

  return (
    <section className="cd-account cd-account--narrow">
      <h1>Saved cards</h1>
      <p className="cd-account__lead">
        <a className="cd-account__link" href="/storefront/account">
          ← Back to your account
        </a>
      </p>
      {justSaved ? <p className="cd-account__notice">Your card was saved.</p> : null}

      {cards.length === 0 ? (
        <p className="cd-account__muted">You don&apos;t have any saved cards yet.</p>
      ) : (
        <ul className="cd-account__cards">
          {cards.map((c) => (
            <li key={c.id} className="cd-account__card">
              <span className="cd-account__card-brand">
                {c.brand ?? "Card"} •••• {c.last4 ?? "----"}
              </span>
              {c.expMonth && c.expYear ? (
                <span className="cd-account__card-exp">
                  {String(c.expMonth).padStart(2, "0")}/{c.expYear}
                </span>
              ) : null}
              <fetcher.Form method="post">
                <input type="hidden" name="cardId" value={c.id} />
                <button type="submit" name="intent" value="detach" className="cd-account__link-btn">
                  Remove
                </button>
              </fetcher.Form>
            </li>
          ))}
        </ul>
      )}

      {!publishableKey ? (
        <p className="cd-account__muted">This store isn&apos;t set up to save cards yet.</p>
      ) : !clientSecret ? (
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="add" />
          {formError ? <p className="cd-account__error">{formError}</p> : null}
          <button type="submit" className="cd-account__submit" disabled={fetcher.state !== "idle"}>
            {fetcher.state !== "idle" ? "Starting…" : "Add a card"}
          </button>
        </fetcher.Form>
      ) : (
        <Elements stripe={stripePromise} options={{ clientSecret }}>
          <AddCardForm returnUrl={`${origin}/storefront/account/cards`} />
        </Elements>
      )}
    </section>
  );
}
