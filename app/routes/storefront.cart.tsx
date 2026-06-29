// app/routes/storefront.cart.tsx
// Buyer cart view (platform pivot #2c-1). Read-only loader: resolve the tenant,
// read the signed cart cookie, price the cart purely from the line snapshots.
// Checkout (payment + PII capture) is #2c-2 — the Checkout link points at its
// future route, which 404s until that module lands.
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { readCartId } from "~/lib/storefront/cart-cookie.server";
import { priceCart } from "~/lib/order/cart.server";

export const meta: MetaFunction = () => {
  const title = "Cart — Calderyn Demo Store";
  return [
    { title },
    { name: "description", content: "Your cart." },
    { property: "og:title", content: title },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const cartId = await readCartId(request);
  // No cookie yet -> empty cart, no DB read.
  if (!cartId) return json({ cart: null });
  // priceCart scopes by (shopId, cartId); a stale/foreign id simply yields 0 lines.
  const cart = await priceCart(shopId, cartId);
  return json({ cart });
}

/** Format integer cents in the line's snapshotted currency for display only. */
function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

export default function StorefrontCart() {
  const { cart } = useLoaderData<typeof loader>();

  if (!cart || cart.lines.length === 0) {
    return (
      <section className="cd-cart cd-cart--empty">
        <h1>Your cart</h1>
        <p className="cd-cart__empty">Your cart is empty.</p>
        <a className="cd-cart__continue" href="/storefront">
          Continue shopping
        </a>
      </section>
    );
  }

  return (
    <section className="cd-cart">
      <h1>Your cart</h1>
      <ul className="cd-cart__lines">
        {cart.lines.map((line) => (
          <li key={line.id} className="cd-cart__line">
            <span className="cd-cart__line-title">{line.titleSnapshot}</span>
            <span className="cd-cart__line-qty">Qty {line.quantity}</span>
            <span className="cd-cart__line-unit">{money(line.unitPriceCents, line.currency)}</span>
            <span className="cd-cart__line-total">
              {money(line.unitPriceCents * line.quantity, line.currency)}
            </span>
          </li>
        ))}
      </ul>
      <div className="cd-cart__summary">
        <span className="cd-cart__subtotal-label">Subtotal</span>
        <span className="cd-cart__subtotal-value">{money(cart.subtotalCents, cart.currency)}</span>
      </div>
      {/* Checkout route ships in #2c-2; this link 404s until then. */}
      <a className="cd-cart__checkout" href="/storefront/checkout">
        Checkout
      </a>
    </section>
  );
}
