import { redirect } from "@remix-run/node";
import { isUuid } from "./ids";
import { getSupabase } from "./supabase.server";

const ALERT_PATH_RE = /^\/app\/alerts\/([^/]+)$/;

/**
 * Resolve the Shopify-admin deep link for an alert-detail URL
 * (`/app/alerts/<uuid>?action=…`, the shape `propose_action` returns as
 * `confirm_url`). An unauthenticated top-level visit to that URL normally
 * bounces to /auth/login and the path is lost; redirecting to
 * admin.shopify.com instead keeps the deep link, because Shopify admin
 * preserves its own URLs through login.
 *
 * Only the alert's shop *handle* is revealed, and only to a caller who
 * already holds the alert UUID (which is shop-scoped to begin with).
 * Returns null when the URL isn't an alert detail or the lookup fails —
 * callers fall back to the stock login redirect.
 */
export async function adminAlertDeepLink(requestUrl: string): Promise<string | null> {
  const url = new URL(requestUrl);
  const match = url.pathname.match(ALERT_PATH_RE);
  const alertId = match?.[1];
  const apiKey = process.env.SHOPIFY_API_KEY;
  if (!alertId || !isUuid(alertId) || !apiKey) return null;

  try {
    const supabase = getSupabase();
    const { data: alert, error: aErr } = await supabase
      .from("alerts")
      .select("shop_id")
      .eq("id", alertId)
      .maybeSingle();
    if (aErr || !alert?.shop_id) return null;

    const { data: shop, error: sErr } = await supabase
      .from("shops")
      .select("shop_domain")
      .eq("id", alert.shop_id)
      .maybeSingle();
    if (sErr || !shop?.shop_domain) return null;

    const handle = String(shop.shop_domain).replace(/\.myshopify\.com$/, "");
    if (!handle) return null;
    return `https://admin.shopify.com/store/${handle}/apps/${apiKey}${url.pathname}${url.search}`;
  } catch (err) {
    console.error(`[admin-deeplink] failed to resolve alert ${alertId}`, err);
    return null;
  }
}

/**
 * If `thrown` is the stock unauthenticated bounce to /auth/login and the
 * request targets an alert detail URL, return a redirect to the admin deep
 * link instead; otherwise null. Callers `throw (await …) ?? thrown`.
 */
export async function adminDeepLinkRedirect(
  request: Request,
  thrown: unknown,
): Promise<Response | null> {
  if (!(thrown instanceof Response)) return null;
  if (thrown.status < 300 || thrown.status >= 400) return null;
  const location = thrown.headers.get("location") ?? "";
  if (!location.includes("/auth/login")) return null;
  const deepLink = await adminAlertDeepLink(request.url);
  return deepLink ? redirect(deepLink) : null;
}
