import type { LoaderFunctionArgs } from "@remix-run/node";
import { priceCart } from "~/lib/order/cart.server";
import { DEMO_SHOP_ID, resolveStorefrontShop } from "~/lib/storefront/shop.server";
import {
  allowStorefrontRequest,
  resolveCartContext,
  storefrontError,
  storefrontOk,
} from "~/lib/storefront/cart-api.server";

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  const shopId = await resolveStorefrontShop(request);
  if (shopId === DEMO_SHOP_ID) return storefrontOk({ cart: null });
  if (!(await allowStorefrontRequest(request, shopId, "cart-read", 120))) {
    return storefrontError(429, "rate_limited");
  }
  const context = await resolveCartContext(request, shopId);
  if (context.kind === "mismatch") return storefrontError(403, "cart_shop_mismatch");
  if (context.kind === "absent") return storefrontOk({ cart: null });
  if (context.kind === "stale") {
    return storefrontOk({ cart: null }, { headers: { "Set-Cookie": context.clearCookie } });
  }
  return storefrontOk({ cart: await priceCart(shopId, context.identity.cartId) });
}
