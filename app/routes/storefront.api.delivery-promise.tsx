// Same-origin endpoint the owned storefront PDP/cart fetches for a delivery promise.
// The storefront is owned (not a Shopify theme), so a same-origin GET suffices — no App Proxy
// HMAC. Returns a COARSE estimate; callers treat any non-200 as "no estimate available" and
// hide the widget rather than showing a potentially wrong date (rule 12).
import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/response.server";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { estimateShipping } from "~/lib/commerce/estimate.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const variantId = url.searchParams.get("variantId");
  const zip = url.searchParams.get("zip");
  const country = url.searchParams.get("country") ?? "US";
  const qty = Math.max(1, Number(url.searchParams.get("qty") ?? "1") || 1);

  if (!variantId) return json({ error: "variantId is required" }, { status: 400 });
  if (!zip) return json({ error: "zip is required" }, { status: 400 });

  const shopId = await resolveStorefrontShop(request);
  try {
    const est = await estimateShipping(shopId, [{ variantId, quantity: qty }], { zip, country });
    return json(est, { headers: { "Cache-Control": "private, max-age=120" } });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    // ORIGIN_NOT_CONFIGURED, RATE_SOURCE_NOT_CONFIGURED, or no options: the PDP hides the
    // promise widget — never show a wrong date (rule 12).
    return json({ error: e.code ?? "ESTIMATE_UNAVAILABLE", message: e.message }, { status: 422 });
  }
}
