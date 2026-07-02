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
import { clearCartId } from "~/lib/storefront/cart-cookie.server";
import { findOrderByConfirmationToken, formatOrderRef } from "~/lib/order/checkout.server";
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

  // Clear the cart cookie ONLY once payment is captured — never for an unpaid `checkout_pending`
  // order, so a buyer who reaches this URL without paying keeps their cart. Idempotent on refresh.
  const headers = new Headers();
  if (captured) headers.append("Set-Cookie", await clearCartId());

  // The webhook may lag, so a genuinely-paid order can still read `checkout_pending` here —
  // reflect it gracefully ("received / processing") rather than hard-failing on not-yet-paid.
  return json(
    {
      ref: formatOrderRef(order.orderId),
      paid: captured,
      totalCents: order.totalCents,
      currency: order.currency,
      lines: order.lines.map((l) => ({ title: l.title, quantity: l.quantity })),
    },
    { headers },
  );
}


export default function StorefrontCheckoutConfirmation() {
  const { ref, paid, totalCents, currency, lines } = useLoaderData<typeof loader>();
  return (
    <section className="cd-confirm">
      <h1>Thank you — your order is in</h1>
      <p className="cd-confirm__status">
        {paid
          ? "Payment confirmed. We're getting your order ready."
          : "We've received your order and are confirming your payment. You'll get an email shortly."}
      </p>
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
