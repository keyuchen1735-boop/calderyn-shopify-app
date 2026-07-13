import type { ActionFunctionArgs } from "@remix-run/node";
import { priceCart, setCartLineQuantity } from "~/lib/order/cart.server";
import { DEMO_SHOP_ID, resolveStorefrontShop } from "~/lib/storefront/shop.server";
import {
  allowStorefrontRequest,
  cartContextError,
  mapCartError,
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
  if (!(await allowStorefrontRequest(request, shopId, "cart-quantity"))) return storefrontError(429, "rate_limited");
  const body = await parseStrictObject(request, ["lineId", "quantity"]);
  if (body instanceof Response) return body;
  if (typeof body.lineId !== "string" || !body.lineId || body.lineId.length > 128
    || !Number.isInteger(body.quantity) || Number(body.quantity) < 1 || Number(body.quantity) > 999) {
    return storefrontError(422, "invalid_request");
  }
  const context = await resolveCartContext(request, shopId);
  if (context.kind !== "active") return cartContextError(context);
  try {
    await setCartLineQuantity(shopId, context.identity.cartId, body.lineId, Number(body.quantity));
    return storefrontOk({ cart: await priceCart(shopId, context.identity.cartId) });
  } catch (error) {
    const mapped = mapCartError(error);
    if (mapped) return mapped;
    throw error;
  }
}
