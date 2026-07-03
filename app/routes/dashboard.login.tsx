// app/routes/dashboard.login.tsx
// GET /dashboard/login → 302 to Shopify authorize. With ?shop= (the embedded
// app's "Open dashboard" button) the shop's own authorize URL is used and the
// state cookie pins `nonce:shop`; without it (/login's "Continue with
// Shopify") the shop-less unified-admin authorize URL is used and the cookie
// pins `nonce:*` — Shopify signs the merchant in and routes the grant to
// their store, so we never ask for the domain. ?error= renders the friendly
// failure state (oauth_failed, app_not_installed) instead of raw JSON.

import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { randomBytes } from "node:crypto";
import dashboard from "~/styles/dashboard.css?url";
import { AuthShell, AuthError } from "~/components/auth/AuthCard";
import {
  isValidShopDomain,
  buildAuthorizeUrl,
} from "~/lib/dashboard/shopify-oauth.server";
import {
  jsonError,
  rateLimit,
  clientIpKey,
  safeDashboardReturnTo,
  publicBaseUrl,
} from "~/lib/dashboard/http.server";
import {
  STATE_COOKIE_NAME,
  SHOPLESS_STATE_SHOP,
  readShopHint,
} from "~/lib/dashboard/cookies.server";

export const meta: MetaFunction = () => [{ title: "Sign in with Shopify — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

type LoginPageData = {
  mode: "error";
  returnTo: string | null;
  errorCode: string | null;
  shop: string | null;
};

export async function loader({ request }: LoaderFunctionArgs) {
  if (!(await rateLimit(clientIpKey(request, "dash-login"), 10, 60_000))) {
    throw jsonError(429, "rate_limited");
  }

  const url = new URL(request.url);
  const errorCode = url.searchParams.get("error");
  const rawShop = url.searchParams.get("shop");
  const hintShop = readShopHint(request);
  const returnTo = safeDashboardReturnTo(url.searchParams.get("return_to"));

  let shop: string | null = null;
  if (rawShop !== null) {
    // Explicit shop in the URL (the embedded-app entry point): validate strictly.
    const candidate = rawShop.trim().toLowerCase();
    if (!isValidShopDomain(candidate)) {
      return json(
        { mode: "error", returnTo, errorCode: "invalid_shop", shop: null } satisfies LoginPageData,
        { status: 422 },
      );
    }
    shop = candidate;
  }

  if (errorCode) {
    // Bounce-back from a failed round-trip: render the failure, never blindly
    // re-redirect (that would loop). The remembered-shop hint only steers the
    // retry link at the right store.
    return { mode: "error", returnTo, errorCode, shop: shop ?? hintShop } satisfies LoginPageData;
  }
  // No ?shop= (direct visit, /login button, connect redirect): go shop-less.
  // Shopify's unified admin signs the merchant in and routes the grant to
  // their store — no store-domain form on our side. The state cookie pins `*`
  // so the callback knows the shop was unknown at initiation and binds the
  // shop from the HMAC-verified callback params instead.
  const state = randomBytes(16).toString("hex");
  const publicUrl = publicBaseUrl();
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
  const cookieShop = shop ?? SHOPLESS_STATE_SHOP;
  const stateValue = returnTo
    ? `${state}:${cookieShop}:${encodeURIComponent(returnTo)}`
    : `${state}:${cookieShop}`;

  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `${STATE_COOKIE_NAME}=${stateValue}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
  // The shop hint is set only AFTER a successful OAuth callback (see
  // dashboard.auth.callback), never here on an unauthenticated GET — otherwise a
  // crafted /dashboard/login?shop=... link could plant a 90-day hint that skews
  // the error page's retry target for the life of the cookie.
  return redirect(authorizeUrl, { headers });
}

export default function DashboardLoginPage() {
  const data = useLoaderData<typeof loader>();
  // Retry re-enters OAuth with everything the failed attempt carried — the
  // shop (when known) and the post-login destination (connector consent).
  const retryParams = new URLSearchParams();
  if (data.shop) retryParams.set("shop", data.shop);
  if (data.returnTo) retryParams.set("return_to", data.returnTo);
  const qs = retryParams.toString();
  const retryHref = qs ? `/dashboard/login?${qs}` : "/dashboard/login";
  // GETs redirect into Shopify OAuth, so the page only renders bounce-back
  // errors — there is no store-domain form: Shopify owns store identity.
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Connect Shopify</h1>
      <p className="cd-auth-sub">Bring your store over.</p>
      <AuthError code={data.errorCode} />
      <div className="cd-auth-links">
        <a href={retryHref}>Try again</a>
        <a href="/login">Sign in another way</a>
      </div>
    </AuthShell>
  );
}
