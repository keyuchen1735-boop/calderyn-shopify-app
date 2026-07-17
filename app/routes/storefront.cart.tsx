// app/routes/storefront.cart.tsx
// Buyer cart view (platform pivot #2c-1). Read-only loader: resolve the tenant,
// read the signed cart cookie, price the cart purely from the line snapshots.
// Checkout (payment + PII capture) is #2c-2 — the Checkout link points at its
// future route, which 404s until that module lands.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { resolveStorefrontShop, DEMO_SHOP_ID } from "~/lib/storefront/shop.server";
import { readCartId } from "~/lib/storefront/cart-cookie.server";
import { priceCart, removeCartLine, clearCart } from "~/lib/order/cart.server";
import { rateLimit, clientIpKey } from "~/lib/rate-limit.server";
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
  if (!runtime1) throw new Response("No runtime-1 storefront release is available.", { status: 503 });
  const nonce = randomBytes(18).toString("base64url");
  const headers = storefrontCacheHeaders({ routeId: "cart", personalized: true });
  markStorefrontBundleRendered(headers, nonce);
  return json({ ...runtime1, nonce }, { headers });
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
  if (!isRuntime1RenderData(loaded)) throw new Error("Runtime-1 cart data is required.");
  return <>{renderStorefrontSurface({ bundle: loaded.bundle, routeId: "cart", data: loaded.data, nonce: loaded.nonce, mode: "public", visualLayerPlacement: loaded.visualLayerPlacement })}<StorefrontHydrator bundle={loaded.bundle} routeId="cart" data={loaded.data} mode="public" /></>;
}
