// Same-origin endpoint the owned storefront PDP/cart fetches for a delivery promise.
// The storefront is owned (not a Shopify theme), so a same-origin GET suffices — no App Proxy
// HMAC. Returns a COARSE estimate; callers treat any non-200 as "no estimate available" and
// hide the widget rather than showing a potentially wrong date (rule 12).
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { estimateShipping } from "~/lib/commerce/estimate.server";
import { rateLimit, clientIpKey } from "~/lib/rate-limit.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const variantId = url.searchParams.get("variantId");
  const zip = url.searchParams.get("zip");
  const country = url.searchParams.get("country") ?? "US";
  const qty = Math.max(1, Number(url.searchParams.get("qty") ?? "1") || 1);

  if (!variantId) return json({ error: "variantId is required" }, { status: 400 });
  if (!zip) return json({ error: "zip is required" }, { status: 400 });

  const shopId = await resolveStorefrontShop(request);
  // Each miss hits a live carrier-rate API; throttle per-IP so zip/qty enumeration
  // cannot burn the merchant's quota.
  if (!(await rateLimit(clientIpKey(request, "delivery-promise"), 20, 60_000))) {
    return json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  try {
    const est = await estimateShipping(shopId, [{ variantId, quantity: qty }], { zip, country });
    return json(est, { headers: { "Cache-Control": "private, max-age=120" } });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    // ORIGIN_NOT_CONFIGURED, RATE_SOURCE_NOT_CONFIGURED, or no options: the PDP hides the
    // promise widget — never show a wrong date (rule 12). This is a public endpoint,
    // so log the detail server-side and never echo raw error text (internal IDs / DB
    // errors) to anonymous buyers.
    console.error(`[delivery-promise] ${e.code ?? "ESTIMATE_UNAVAILABLE"}: ${e.message ?? ""}`);
    return json({ error: e.code ?? "ESTIMATE_UNAVAILABLE" }, { status: 422 });
  }
}
