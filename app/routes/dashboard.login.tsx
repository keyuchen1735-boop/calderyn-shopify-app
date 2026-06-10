// app/routes/dashboard.login.tsx
// GET /dashboard/login?shop=x.myshopify.com → 302 to Shopify authorize.
// The state nonce lives in a short-lived HttpOnly cookie as `nonce:shop`.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { randomBytes } from "node:crypto";
import {
  isValidShopDomain,
  buildAuthorizeUrl,
} from "~/lib/dashboard/shopify-oauth.server";
import { jsonError, rateLimit, clientIpKey } from "~/lib/dashboard/http.server";

export const STATE_COOKIE_NAME = "dash_oauth";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!rateLimit(clientIpKey(request, "dash-login"), 10, 60_000)) {
    return jsonError(429, "rate_limited");
  }

  const shop = (new URL(request.url).searchParams.get("shop") ?? "")
    .trim()
    .toLowerCase();
  if (!isValidShopDomain(shop)) {
    return jsonError(422, "invalid_shop", "Expected <name>.myshopify.com");
  }

  const state = randomBytes(16).toString("hex");
  const publicUrl = process.env.DASHBOARD_PUBLIC_URL ?? process.env.SHOPIFY_APP_URL ?? "";
  const authorizeUrl = buildAuthorizeUrl({
    shop,
    clientId: process.env.SHOPIFY_API_KEY ?? "",
    scopes: process.env.SCOPES ?? "",
    redirectUri: `${publicUrl}/dashboard/auth/callback`,
    state,
  });

  return redirect(authorizeUrl, {
    headers: {
      "Set-Cookie": `${STATE_COOKIE_NAME}=${state}:${shop}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
