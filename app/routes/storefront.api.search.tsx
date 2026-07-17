import type { LoaderFunctionArgs } from "@remix-run/node";
import { InvalidSearchRequestError, parseStorefrontSearchParams, searchStorefront } from "~/lib/storefront/search.server";
import { DEMO_SHOP_ID, resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { allowStorefrontRequest, storefrontError, storefrontOk } from "~/lib/storefront/cart-api.server";

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  const shopId = await resolveStorefrontShop(request);
  if (shopId === DEMO_SHOP_ID) return storefrontError(404, "storefront_not_found");
  if (!(await allowStorefrontRequest(request, shopId, "search", 60))) return storefrontError(429, "rate_limited");
  try {
    const input = parseStorefrontSearchParams(new URL(request.url).searchParams);
    const { presentationProducts: _presentationProducts, ...result } = await searchStorefront(shopId, input);
    return storefrontOk(result);
  } catch (error) {
    if (error instanceof InvalidSearchRequestError) return storefrontError(422, "invalid_search_request");
    throw error;
  }
}
