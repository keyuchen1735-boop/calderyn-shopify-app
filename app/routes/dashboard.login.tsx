// app/routes/dashboard.login.tsx
// GET /dashboard/login?shop=x.myshopify.com → 302 to Shopify authorize.
// The state nonce lives in a short-lived HttpOnly cookie as `nonce:shop`.
//
// This is the Shopify-identity entry, reached from the embedded app's "Open
// dashboard" button (always ?shop=) and from /login's "Continue with Shopify"
// (no ?shop= — renders the store-domain form on the auth card, pre-filled from
// the __Host-dash_shop hint, never auto-redirecting: entering Shopify OAuth is
// always an explicit user action). ?error= renders the friendly failure state
// (oauth_failed, app_not_installed) instead of raw JSON.

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
} from "~/lib/dashboard/http.server";
import { STATE_COOKIE_NAME, readShopHint } from "~/lib/dashboard/cookies.server";

export const meta: MetaFunction = () => [{ title: "Sign in with Shopify — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

type LoginPageData = {
  mode: "form" | "error";
  hintShop: string | null;
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
        { mode: "error", hintShop, returnTo, errorCode: "invalid_shop", shop: null } satisfies LoginPageData,
        { status: 422 },
      );
    }
    shop = candidate;
  }

  if (errorCode) {
    // Bounce-back from a failed round-trip: render the failure, never blindly
    // re-redirect (that would loop).
    return { mode: "error", hintShop, returnTo, errorCode, shop: shop ?? hintShop } satisfies LoginPageData;
  }
  if (!shop) {
    // No shop supplied (direct visit, /login button, connect redirect): ask for
    // it. The hint only pre-fills the form — no automatic redirect into OAuth.
    return { mode: "form", hintShop, returnTo, errorCode: null, shop: null } satisfies LoginPageData;
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
  const stateValue = returnTo
    ? `${state}:${shop}:${encodeURIComponent(returnTo)}`
    : `${state}:${shop}`;

  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `${STATE_COOKIE_NAME}=${stateValue}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
  // The shop hint is set only AFTER a successful OAuth callback (see
  // dashboard.auth.callback), never here on an unauthenticated GET — otherwise a
  // crafted /dashboard/login?shop=... link could plant a 90-day hint that skews
  // the form pre-fill for the life of the cookie.
  return redirect(authorizeUrl, { headers });
}

export default function DashboardLoginPage() {
  const data = useLoaderData<typeof loader>();
  const retryHref = data.shop
    ? `/dashboard/login?shop=${encodeURIComponent(data.shop)}`
    : "/dashboard/login";
  return (
    <AuthShell>
      <h1 className="cd-auth-title">Sign in with Shopify</h1>
      <p className="cd-auth-sub">Connect your store and bring your data with you.</p>
      {data.mode === "error" ? (
        <>
          <AuthError code={data.errorCode} />
          <div className="cd-auth-links">
            <a href={retryHref}>Try again</a>
            <a href="/login">Sign in another way</a>
          </div>
        </>
      ) : (
        <>
          <form method="get" action="/dashboard/login">
            <label className="cd-auth-label" htmlFor="shop">
              Store domain
            </label>
            <input
              className="cd-auth-input"
              id="shop"
              name="shop"
              type="text"
              required
              placeholder="example.myshopify.com"
              defaultValue={data.hintShop ?? ""}
              pattern="[A-Za-z0-9][A-Za-z0-9-]*\.[Mm][Yy][Ss][Hh][Oo][Pp][Ii][Ff][Yy]\.[Cc][Oo][Mm]"
              autoComplete="on"
            />
            {data.returnTo ? <input type="hidden" name="return_to" value={data.returnTo} /> : null}
            <button className="cd-auth-submit" type="submit">
              Continue
            </button>
          </form>
          <p className="cd-auth-foot">
            Prefer email? <a href="/login">Sign in another way</a>
          </p>
        </>
      )}
    </AuthShell>
  );
}
