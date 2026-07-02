// app/routes/storefront.cart.tsx
// Buyer cart view (platform pivot #2c-1). Read-only loader: resolve the tenant,
// read the signed cart cookie, price the cart purely from the line snapshots.
// Checkout (payment + PII capture) is #2c-2 — the Checkout link points at its
// future route, which 404s until that module lands.
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { resolveStorefrontShop, DEMO_SHOP_ID } from "~/lib/storefront/shop.server";
import { readCartId } from "~/lib/storefront/cart-cookie.server";
import { priceCart } from "~/lib/order/cart.server";
import { formatMoney as money } from "~/lib/storefront/money";
import { storeNameFromMatches } from "~/lib/storefront/meta";

export const meta: MetaFunction = ({ matches }) => {
  const title = `Cart — ${storeNameFromMatches(matches)}`;
  return [
    { title },
    { name: "description", content: "Your cart." },
    { property: "og:title", content: title },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  // The demo shell is browse-only (no shop row, uuid-keyed cart tables can't
  // hold its sentinel id) — always an empty cart, never a DB read.
  if (shopId === DEMO_SHOP_ID) return json({ cart: null });
  const cartId = await readCartId(request);
  // No cookie yet -> empty cart, no DB read.
  if (!cartId) return json({ cart: null });
  // priceCart scopes by (shopId, cartId); a stale/foreign id simply yields 0 lines.
  const cart = await priceCart(shopId, cartId);
  return json({ cart });
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
