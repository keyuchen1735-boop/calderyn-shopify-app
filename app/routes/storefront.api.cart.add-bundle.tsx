import type { ActionFunctionArgs } from "@remix-run/node";
import { addCartLines, buildCart, priceCart } from "~/lib/order/cart.server";
import { commitCartId } from "~/lib/storefront/cart-cookie.server";
import { DEMO_SHOP_ID, resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { allowStorefrontRequest, mapCartError, parseStrictObject, requireJsonContent, requireStorefrontOrigin, resolveCartContext, storefrontError, storefrontOk } from "~/lib/storefront/cart-api.server";

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  const shopId = await resolveStorefrontShop(request);
  if (shopId === DEMO_SHOP_ID) return storefrontError(404, "storefront_not_found");
  const originError = requireStorefrontOrigin(request);
  if (originError) return originError;
  const contentError = requireJsonContent(request);
  if (contentError) return contentError;
  if (!(await allowStorefrontRequest(request, shopId, "cart-add-bundle"))) return storefrontError(429, "rate_limited");
  const body = await parseStrictObject(request, ["lines"]);
  if (body instanceof Response) return body;
  if (!Array.isArray(body.lines) || body.lines.length < 2 || body.lines.length > 12 || body.lines.some((line) => {
    if (!line || typeof line !== "object" || Array.isArray(line)) return true;
    const candidate = line as Record<string, unknown>;
    return Object.keys(candidate).some((key) => key !== "variantId" && key !== "quantity") ||
      typeof candidate.variantId !== "string" || !candidate.variantId || candidate.variantId.length > 128 || candidate.quantity !== 1;
  })) return storefrontError(422, "invalid_request");
  const lines = body.lines as Array<{ variantId: string; quantity: 1 }>;
  const context = await resolveCartContext(request, shopId);
  if (context.kind === "mismatch") return storefrontError(403, "cart_shop_mismatch");
  const cartId = context.kind === "active" ? context.identity.cartId : (await buildCart(shopId)).id;
  const setCookie = context.kind === "active" ? context.upgradeCookie : await commitCartId(cartId, shopId);
  try {
    await addCartLines(shopId, cartId, lines);
    return storefrontOk({ cart: await priceCart(shopId, cartId) }, setCookie ? { headers: { "Set-Cookie": setCookie } } : {});
  } catch (error) {
    const mapped = mapCartError(error);
    if (mapped) return mapped;
    throw error;
  }
}
