import type { ActionFunctionArgs } from "@remix-run/node";
import { clearCart, priceCart } from "~/lib/order/cart.server";
import { DEMO_SHOP_ID, resolveStorefrontShop } from "~/lib/storefront/shop.server";
import {
  allowStorefrontRequest,
  cartContextError,
  parseStrictObject,
  requireJsonContent,
  requireStorefrontOrigin,
  resolveCartContext,
  storefrontError,
  storefrontOk,
} from "~/lib/storefront/cart-api.server";

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  const shopId = await resolveStorefrontShop(request);
  if (shopId === DEMO_SHOP_ID) return storefrontError(404, "storefront_not_found");
  const boundaryError = requireStorefrontOrigin(request) ?? requireJsonContent(request);
  if (boundaryError) return boundaryError;
  if (!(await allowStorefrontRequest(request, shopId, "cart-clear"))) return storefrontError(429, "rate_limited");
  const body = await parseStrictObject(request, []);
  if (body instanceof Response) return body;
  const context = await resolveCartContext(request, shopId);
  if (context.kind !== "active") return cartContextError(context);
  await clearCart(shopId, context.identity.cartId);
  return storefrontOk(
    { cart: await priceCart(shopId, context.identity.cartId) },
    context.upgradeCookie ? { headers: { "Set-Cookie": context.upgradeCookie } } : {},
  );
}
