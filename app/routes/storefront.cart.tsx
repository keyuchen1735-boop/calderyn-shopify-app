// app/routes/storefront.cart.tsx
// Buyer cart view (platform pivot #2c-1). Read-only loader: resolve the tenant,
// read the signed cart cookie, price the cart purely from the line snapshots.
// Checkout (payment + PII capture) is #2c-2 — the Checkout link points at its
// future route, which 404s until that module lands.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { resolveStorefrontShop, DEMO_SHOP_ID } from "~/lib/storefront/shop.server";
import { readCartId } from "~/lib/storefront/cart-cookie.server";
import { trackStorefrontEvent } from "~/lib/storefront/events.server";
import { priceCart, removeCartLine, clearCart } from "~/lib/order/cart.server";
import { loadShipRules } from "~/lib/shipping/rules.server";
import { rateLimit, clientIpKey } from "~/lib/rate-limit.server";
import { formatMoney as money } from "~/lib/storefront/money";
import { storeNameFromMatches } from "~/lib/storefront/meta";
import { randomBytes } from "node:crypto";
import { resolveRuntime1Route } from "~/lib/storefront-runtime/release-resolution.server";
import { isRuntime1RenderData, renderStorefrontSurface } from "~/lib/storefront-runtime/render";
import { markStorefrontBundleRendered } from "~/lib/storefront-runtime/csp.server";
import { storefrontCacheHeaders } from "~/lib/storefront-runtime/cache.server";
import type { PublicCart } from "~/lib/storefront-runtime/public-data.server";
import { StorefrontHydrator } from "~/lib/storefront-runtime/storefront-hydrator";

export const meta: MetaFunction = ({ matches }) => {
  const title = `Cart — ${storeNameFromMatches(matches)}`;
  return [
    { title },
    { name: "description", content: "Your cart." },
    { property: "og:title", content: title },
  ];
};
export const headers: HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const runtime1 = await resolveRuntime1Route({
    shopId,
    request,
    route: { kind: "cart" },
    dataDependencies: {
      cartLoader: async (): Promise<PublicCart | null> => {
        if (shopId === DEMO_SHOP_ID) return null;
        const cartId = await readCartId(request);
        if (!cartId) return null;
        const priced = await priceCart(shopId, cartId);
        return {
          id: priced.cartId,
          count: priced.lines.reduce((sum, line) => sum + line.quantity, 0),
          lines: priced.lines.map((line) => ({
            id: line.id,
            title: line.titleSnapshot,
            quantity: line.quantity,
            unitPrice: { cents: line.unitPriceCents, currency: line.currency.toUpperCase() },
            total: { cents: line.unitPriceCents * line.quantity, currency: line.currency.toUpperCase() },
          })),
          subtotal: { cents: priced.subtotalCents, currency: priced.currency.toUpperCase() },
          discounts: { cents: 0, currency: priced.currency.toUpperCase() },
          total: { cents: priced.subtotalCents, currency: priced.currency.toUpperCase() },
        };
      },
    },
  });
  if (runtime1) {
    const nonce = randomBytes(18).toString("base64url");
    const headers = storefrontCacheHeaders({ routeId: "cart", personalized: true });
    markStorefrontBundleRendered(headers, nonce);
    return json({ ...runtime1, nonce }, { headers });
  }
  // The demo shell is browse-only (no shop row, uuid-keyed cart tables can't
  // hold its sentinel id) — always an empty cart, never a DB read.
  if (shopId === DEMO_SHOP_ID) return json({ cart: null, freeShipThresholdCents: null, error: null });
  const track = await trackStorefrontEvent(request, shopId, "page_view");
  const cartId = await readCartId(request);
  // No cookie yet -> empty cart, no DB read.
  if (!cartId) return json({ cart: null, freeShipThresholdCents: null, error: null }, { headers: track });
  // priceCart scopes by (shopId, cartId); a stale/foreign id simply yields 0 lines. A cart whose
  // lines somehow mix currencies would otherwise throw here and make the page un-viewable (the only
  // route from which a buyer could remove the offending line), so degrade to a null cart + notice
  // instead of a 500 — the empty-cart control below is still reachable to recover.
  // Free-shipping nudge: when the merchant set a threshold (ship_rules), tell the
  // buyer how close they are — the single strongest basket-size lever. Best-effort
  // and started BEFORE pricing so the independent reads overlap: a rules read hiccup
  // renders the cart without the banner, never a 500.
  const freeShipP = loadShipRules(shopId).then(
    (rules) => rules.freeShipThresholdCents,
    (err) => {
      console.error(`[cart] ship_rules read failed for shop ${shopId} (no free-ship banner):`, err);
      return null;
    },
  );
  try {
    const cart = await priceCart(shopId, cartId);
    return json(
      { cart, cartId, freeShipThresholdCents: await freeShipP, error: null },
      { headers: track },
    );
  } catch (err) {
    console.error(`[cart] could not price cart ${cartId} for shop ${shopId}:`, err);
    return json(
      { cart: null, cartId, freeShipThresholdCents: null, error: "unpriceable" as const },
      { headers: track },
    );
  }
}

/**
 * Cart mutations (#2c-1): remove a single line or empty the whole cart. This is the buyer's only
 * in-app recovery when a cart holds a now-unavailable / archived variant — without it that cart
 * dead-ends checkout in a permanent 502 with no way to drop the offending item. Shop + cart scoped
 * (the cart id comes from the signed cookie, never the body), throttled, redirect-after-POST.
 */
export async function action({ request }: ActionFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  // The demo shell owns no cart row; bounce a crafted POST instead of 500ing on the uuid tables.
  if (shopId === DEMO_SHOP_ID) return redirect("/storefront/cart");
  if (!(await rateLimit(clientIpKey(request, "cart-edit"), 30, 60_000))) {
    throw new Response("Too many requests", { status: 429 });
  }
  const cartId = await readCartId(request);
  if (!cartId) return redirect("/storefront/cart");

  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "clear") {
    await clearCart(shopId, cartId);
  } else if (intent === "remove") {
    const lineId = form.get("lineId");
    if (typeof lineId !== "string" || lineId.length === 0) {
      throw new Response("lineId is required", { status: 400 });
    }
    await removeCartLine(shopId, cartId, lineId);
  } else {
    throw new Response("unknown cart action", { status: 400 });
  }
  // Redirect after the mutation to avoid a double-submit on refresh.
  return redirect("/storefront/cart");
}


export default function StorefrontCart() {
  const loaded = useLoaderData<typeof loader>();
  if (isRuntime1RenderData(loaded)) {
    return <>{renderStorefrontSurface({ bundle: loaded.bundle, routeId: "cart", data: loaded.data, nonce: loaded.nonce, mode: "public", visualLayerPlacement: loaded.visualLayerPlacement })}<StorefrontHydrator bundle={loaded.bundle} routeId="cart" data={loaded.data} mode="public" /></>;
  }
  const { cart, freeShipThresholdCents, error } = loaded;

  if (!cart || cart.lines.length === 0) {
    return (
      <section className="cd-cart cd-cart--empty">
        <h1>Your cart</h1>
        {error === "unpriceable" ? (
          <>
            <p className="cd-cart__empty">
              We couldn&apos;t load your cart. You can empty it and start again.
            </p>
            <Form method="post">
              <input type="hidden" name="intent" value="clear" />
              <button type="submit" className="cd-cart__empty-btn">
                Empty cart
              </button>
            </Form>
          </>
        ) : (
          <p className="cd-cart__empty">Your cart is empty.</p>
        )}
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
            <Form method="post" className="cd-cart__line-remove">
              <input type="hidden" name="intent" value="remove" />
              <input type="hidden" name="lineId" value={line.id} />
              <button type="submit" className="cd-cart__remove-btn" aria-label={`Remove ${line.titleSnapshot}`}>
                Remove
              </button>
            </Form>
          </li>
        ))}
      </ul>
      {freeShipThresholdCents != null ? (
        cart.subtotalCents >= freeShipThresholdCents ? (
          <p className="cd-cart__freeship cd-cart__freeship--unlocked">
            You&apos;ve unlocked free shipping.
          </p>
        ) : (
          <p className="cd-cart__freeship">
            Add {money(freeShipThresholdCents - cart.subtotalCents, cart.currency)} more for free
            shipping.
          </p>
        )
      ) : null}
      <div className="cd-cart__summary">
        <span className="cd-cart__subtotal-label">Subtotal</span>
        <span className="cd-cart__subtotal-value">{money(cart.subtotalCents, cart.currency)}</span>
      </div>
      <div className="cd-cart__actions">
        <Form method="post">
          <input type="hidden" name="intent" value="clear" />
          <button type="submit" className="cd-cart__empty-btn">
            Empty cart
          </button>
        </Form>
        <a className="cd-cart__checkout" href="/storefront/checkout">
          Checkout
        </a>
      </div>
    </section>
  );
}
