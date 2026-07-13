import type { ActionFunctionArgs } from "@remix-run/node";
import { addCartLine, buildCart, priceCart } from "~/lib/order/cart.server";
import { commitCartId } from "~/lib/storefront/cart-cookie.server";
import { DEMO_SHOP_ID, resolveStorefrontShop } from "~/lib/storefront/shop.server";
import {
  allowStorefrontRequest,
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
  const originError = requireStorefrontOrigin(request);
  if (originError) return originError;
  const contentError = requireJsonContent(request);
  if (contentError) return contentError;
  if (!(await allowStorefrontRequest(request, shopId, "cart-add"))) return storefrontError(429, "rate_limited");
  const body = await parseStrictObject(request, ["variantId", "quantity"]);
  if (body instanceof Response) return body;
  if (typeof body.variantId !== "string" || !body.variantId || body.variantId.length > 128
    || !Number.isInteger(body.quantity) || Number(body.quantity) < 1 || Number(body.quantity) > 999) {
    return storefrontError(422, "invalid_request");
  }

  const context = await resolveCartContext(request, shopId);
  if (context.kind === "mismatch") return storefrontError(403, "cart_shop_mismatch");
  let cartId: string;
  let setCookie: string | null = null;
  if (context.kind === "active") {
    cartId = context.identity.cartId;
    setCookie = context.upgradeCookie;
  } else {
    cartId = (await buildCart(shopId)).id;
    setCookie = await commitCartId(cartId, shopId);
  }
  try {
    await addCartLine(shopId, cartId, body.variantId, Number(body.quantity));
    return storefrontOk(
      { cart: await priceCart(shopId, cartId) },
      setCookie ? { headers: { "Set-Cookie": setCookie } } : {},
    );
  } catch (error) {
    const mapped = mapCartError(error);
    if (mapped) return mapped;
    throw error;
  }
}
