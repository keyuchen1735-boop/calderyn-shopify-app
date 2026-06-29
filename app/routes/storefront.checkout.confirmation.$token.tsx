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

export const meta: MetaFunction = () => [
  { title: "Order confirmation — Calderyn Demo Store" },
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

  // Clear the cart cookie now that the order is placed (idempotent — safe on a refresh).
  const headers = new Headers();
  headers.append("Set-Cookie", await clearCartId());

  // The webhook may lag, so the order can still be `checkout_pending` here — reflect it
  // gracefully ("received / processing") rather than hard-failing on not-yet-paid.
  return json(
    {
      ref: formatOrderRef(order.orderId),
      paid: order.state === "paid",
      totalCents: order.totalCents,
      currency: order.currency,
      lines: order.lines.map((l) => ({ title: l.title, quantity: l.quantity })),
    },
    { headers },
  );
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
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
