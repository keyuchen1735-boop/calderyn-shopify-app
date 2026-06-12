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

// Long-lived hint so a returning merchant whose dashboard session expired (or
// who bookmarked /dashboard) can be auto-redirected to Shopify without us
// having to ask which store they are — standard OAuth needs the shop to build
// the authorize URL, and nothing else here remembers it. Not a secret: the
// value is constrained to *.myshopify.com and only ever used to build a
// myshopify authorize URL, the same trust boundary as the ?shop param.
export const SHOP_HINT_COOKIE_NAME = "__Host-dash_shop";
const SHOP_HINT_MAX_AGE = 90 * 86_400; // 90 days

export function shopHintCookieHeader(shop: string): string {
  return `${SHOP_HINT_COOKIE_NAME}=${shop}; Max-Age=${SHOP_HINT_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function readShopHint(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SHOP_HINT_COOKIE_NAME) {
      const value = rest.join("=").trim().toLowerCase();
      return isValidShopDomain(value) ? value : null;
    }
  }
  return null;
}

// Only same-origin dashboard paths may be carried through the OAuth round-trip,
// so a crafted ?return_to= can't turn login into an open redirect. Rejects
// absolute URLs, protocol-relative (`//host`), and backslash tricks.
export function safeDashboardReturnTo(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/dashboard/")) return null;
  if (raw.startsWith("//") || raw.includes("\\") || raw.includes("://")) return null;
  return raw;
}

// Friendly HTML for the cases we cannot auto-redirect: a cold visitor we have
// no shop for, or a bounce-back from a failed OAuth round-trip (where blindly
// re-redirecting would loop). Beats dumping raw JSON at a person's browser.
function loginInfoPage(shop: string | null, errored: boolean): Response {
  const retry = shop
    ? `<p><a href="/dashboard/login?shop=${encodeURIComponent(shop)}">Try signing in again</a></p>`
    : "";
  const lead = errored
    ? "We couldn't complete sign-in."
    : "Open Calderyn from your Shopify admin to sign in.";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Calderyn — Sign in</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#1a1a1a}h1{font-size:1.25rem}a{color:#5b3df5}</style></head><body><h1>Calderyn dashboard</h1><p>${lead}</p><p>From your store admin, open the Calderyn app and choose <strong>Open dashboard</strong>.</p>${retry}</body></html>`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!rateLimit(clientIpKey(request, "dash-login"), 10, 60_000)) {
    return jsonError(429, "rate_limited");
  }

  const url = new URL(request.url);
  const errored = url.searchParams.has("error");
  const rawShop = url.searchParams.get("shop");

  let shop: string | null;
  if (rawShop !== null) {
    // Explicit shop in the URL (the embedded-app entry point): validate strictly.
    const candidate = rawShop.trim().toLowerCase();
    if (!isValidShopDomain(candidate)) {
      return jsonError(422, "invalid_shop", "Expected <name>.myshopify.com");
    }
    shop = candidate;
  } else {
    // No shop supplied (direct visit, expired-session redirect): fall back to
    // the remembered shop so we can still auto-redirect.
    shop = readShopHint(request);
  }

  if (!shop || errored) {
    return loginInfoPage(shop, errored);
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

  // Carry a validated post-login destination (e.g. /dashboard/connect?t=…) in
  // the state cookie so it survives the OAuth round-trip. URL-encoded so its
  // query string can't collide with the cookie's `:` field separators.
  const returnTo = safeDashboardReturnTo(url.searchParams.get("return_to"));
  const stateValue = returnTo
    ? `${state}:${shop}:${encodeURIComponent(returnTo)}`
    : `${state}:${shop}`;

  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `${STATE_COOKIE_NAME}=${stateValue}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
  headers.append("Set-Cookie", shopHintCookieHeader(shop));
  return redirect(authorizeUrl, { headers });
}
