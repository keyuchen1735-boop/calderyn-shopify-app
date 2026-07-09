// app/routes/storefront.checkout.confirmation.$token.tsx
// Order confirmation (platform pivot #2c-2). IDOR-SAFE: the order is resolved ONLY by the
// unguessable per-order confirmation_token, scoped to the shop — never by the enumerable order
// id. An unknown or foreign token resolves to nothing and 404s, exposing no order and no PII.
// PII display is intentionally minimal (no address/email echo) — just the buyer's own lines +
// total + a generic "received" message. The cart cookie is cleared here so a placed order starts
// the buyer fresh.
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { clearCartId, readCartId } from "~/lib/storefront/cart-cookie.server";
import { trackStorefrontEvent } from "~/lib/storefront/events.server";
import { resolveServedExperiment } from "~/lib/experiments/store-experiment.server";
import { findOrderByConfirmationToken, formatOrderRef } from "~/lib/order/checkout.server";
import { getCartState } from "~/lib/order/cart.server";
import { formatMoney as money } from "~/lib/storefront/money";
import { storeNameFromMatches } from "~/lib/storefront/meta";

export const meta: MetaFunction = ({ matches }) => [
  { title: `Order confirmation — ${storeNameFromMatches(matches)}` },
  { name: "robots", content: "noindex" },
];

export async function loader({ request, params }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const token = params.token ?? "";
  // Look the order up by its unguessable token, scoped to the shop. A missing/unknown/foreign
  // token yields null -> 404, so the confirmation URL can never be enumerated into another
  // buyer's order. (No token -> skip the DB read entirely.)
  const order = token ? await findOrderByConfirmationToken(shopId, token) : null;
  if (!order) throw new Response("Order not found", { status: 404 });

  // A valid token only proves the checkout was ORIGINATED, not paid — the order sits in
  // `checkout_pending` until the Stripe webhook confirms capture, then advances to `paid` and
  // later `fulfilled`/`refunded`. "Captured" = payment was taken (paid or any state beyond it),
  // keyed off the whole set rather than the exact `paid` state so the status stays honest after
  // the order moves on (a `fulfilled` order must not read as "still confirming payment").
  const captured =
    order.state === "paid" || order.state === "fulfilled" || order.state === "refunded";

  // Clear the cart cookie ONLY when payment is captured AND the cookie still points at the CONSUMED
  // cart (the one this checkout marked 'checkout_pending'). The order carries no cart_id, so we tell
  // the just-purchased cart from a fresh ACTIVE basket by its state: without this guard, viewing ANY
  // past paid order from account history wiped the buyer's in-progress cart cookie. A fresh cart is
  // in 'cart' state, so it is never cleared; an unpaid (webhook-lagged) order keeps the cart too.
  const headers = new Headers();
  if (captured) {
    const cookieCartId = await readCartId(request);
    const cookieCartState = cookieCartId ? await getCartState(shopId, cookieCartId) : null;
    // Only a consumed cart (or a stale cookie whose cart no longer exists) is safe to clear; an
    // active 'cart' basket the buyer is building must survive viewing an old receipt.
    if (cookieCartState === "checkout_pending" || cookieCartState === null) {
      headers.append("Set-Cookie", await clearCartId());
    }
  }

  // Experiment stamp for the checkout_complete row: the report treats stamped
  // checkout_complete sessions as the conversion fallback for orders that lost their
  // attribution (a transient lookup failure at checkout origination) — without this stamp
  // that fallback can never match anything. Only orders CREATED under the running
  // experiment stamp: a bookmarked receipt revisited after a NEW test started must not
  // fabricate a conversion for a test the purchase predates. Shared resolver = same
  // cookie-only bucketing as every other surface; failure-isolated inside it.
  let exposure: { experimentId?: string; variantKey?: string } = {};
  if (captured) {
    const served = await resolveServedExperiment(shopId, request, "checkout");
    const orderInWindow =
      served.experiment != null && Date.parse(order.createdAt) >= Date.parse(served.experiment.startedAt);
    if (served.experimentId && served.variantKey && orderInWindow) {
      exposure = { experimentId: served.experimentId, variantKey: served.variantKey };
    }
  }

  // Funnel terminal: the buyer's browser is back from Stripe with a captured
  // payment. Refresh duplicates are harmless — the funnel counts distinct
  // sessions. An unpaid (webhook-lagged) visit stays an ordinary page view.
  const track = await trackStorefrontEvent(
    request,
    shopId,
    captured ? "checkout_complete" : "page_view",
    exposure,
  );
  for (const c of track.getSetCookie()) headers.append("Set-Cookie", c);

  // Reflect the ACTUAL order state so the buyer is never falsely reassured. The webhook may lag
  // (order still `checkout_pending` reads as "processing"), but a `cancelled`/`refunded` order
  // must show its terminal status — not the "we'll email you shortly" processing copy.
  // `fulfilled` is post-paid, so it reads as confirmed.
  const status: "confirmed" | "processing" | "cancelled" | "refunded" =
    order.state === "paid" || order.state === "fulfilled"
      ? "confirmed"
      : order.state === "cancelled"
        ? "cancelled"
        : order.state === "refunded"
          ? "refunded"
          : "processing";

  return json(
    {
      ref: formatOrderRef(order.orderId),
      status,
      totalCents: order.totalCents,
      currency: order.currency,
      lines: order.lines.map((l) => ({ title: l.title, quantity: l.quantity })),
    },
    { headers },
  );
}


const HEADING: Record<"confirmed" | "processing" | "cancelled" | "refunded", string> = {
  confirmed: "Thank you — your order is in",
  processing: "Thank you — your order is in",
  cancelled: "This order was cancelled",
  refunded: "This order was refunded",
};

const STATUS_COPY: Record<"confirmed" | "processing" | "cancelled" | "refunded", string> = {
  confirmed: "Payment confirmed. We're getting your order ready.",
  processing:
    "We've received your order and are confirming your payment. You'll get an email shortly.",
  cancelled: "This order was cancelled and you have not been charged.",
  refunded: "This order has been refunded. The amount below was returned to your payment method.",
};

export default function StorefrontCheckoutConfirmation() {
  const { ref, status, totalCents, currency, lines } = useLoaderData<typeof loader>();
  return (
    <section className="cd-confirm">
      <h1>{HEADING[status]}</h1>
      <p className="cd-confirm__status">{STATUS_COPY[status]}</p>
      <p className="cd-confirm__ref">
        Order reference <strong>{ref}</strong>
      </p>
      <ul className="cd-confirm__lines">
        {lines.map((line, i) => (
          <li key={i} className="cd-confirm__line">
            <span className="cd-confirm__line-title">{line.title}</span>
            <span className="cd-confirm__line-qty">Qty {line.quantity}</span>
          </li>
        ))}
      </ul>
      <div className="cd-confirm__total">
        <span>Total</span>
        <span>{money(totalCents, currency)}</span>
      </div>
      <a className="cd-confirm__continue" href="/storefront">
        Continue shopping
      </a>
    </section>
  );
}
