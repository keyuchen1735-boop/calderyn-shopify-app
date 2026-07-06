// app/routes/dashboard.login.tsx
// GET /dashboard/login. Shopify's authorization code grant is per-shop
// (https://{shop}/admin/oauth/authorize) — there is no shop-less authorize
// endpoint — so the store domain must be known before we can redirect. With a
// valid ?shop= (the domain form's submit, or the embedded app's "Open
// dashboard" deep link) we 302 to that shop's authorize URL and pin the state
// cookie to `nonce:shop`; without it we render the store-domain form (which
// re-enters as ?shop=). ?error= renders the friendly failure state
// (oauth_failed, app_not_installed) instead of raw JSON.

import type { LinksFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { randomBytes } from "node:crypto";
import dashboard from "~/styles/dashboard.css?url";
import { AuthShell, AuthError } from "~/components/auth/AuthCard";
import {
  isValidShopDomain,
  normalizeShopInput,
  buildAuthorizeUrl,
} from "~/lib/dashboard/shopify-oauth.server";
import {
  jsonError,
  rateLimit,
  clientIpKey,
  safeDashboardReturnTo,
  publicBaseUrl,
} from "~/lib/dashboard/http.server";
import { STATE_COOKIE_NAME, readShopHint } from "~/lib/dashboard/cookies.server";

export const meta: MetaFunction = () => [{ title: "Sign in with Shopify — Calderyn" }];
export const links: LinksFunction = () => [{ rel: "stylesheet", href: dashboard }];

type LoginPageData = {
  // "form": collect the store domain; "error": bounce-back failure state.
  mode: "form" | "error";
  returnTo: string | null;
  errorCode: string | null;
  shop: string | null;
  // Remembered store domain (successful-callback cookie), pre-fills the form.
  hintShop: string | null;
};

// Marks the pass that runs once the browser has been routed to the canonical
// public host, so the host bounce inside the loader fires at most once.
const OAUTH_HOST_MARKER = "_oh";

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
    // A store domain was supplied (the domain form's submit, or the embedded
    // app's "Open dashboard" deep link): normalize a bare handle / pasted URL,
    // then validate strictly.
    const candidate = normalizeShopInput(rawShop);
    if (!isValidShopDomain(candidate)) {
      return json(
        { mode: "error", returnTo, errorCode: "invalid_shop", shop: null, hintShop } satisfies LoginPageData,
        { status: 422 },
      );
    }
    shop = candidate;
  }

  if (errorCode) {
    // Bounce-back from a failed round-trip: render the failure, never blindly
    // re-redirect (that would loop). The remembered-shop hint only steers the
    // retry link at the right store.
    return { mode: "error", returnTo, errorCode, shop: shop ?? hintShop, hintShop } satisfies LoginPageData;
  }

  // The Shopify OAuth callback always lands on the canonical public host
  // (redirect_uri below = publicBaseUrl), but the __Host- state cookie set just
  // before that redirect is locked to the exact host serving this request. A
  // merchant who reaches this flow on the app origin (app.calderyncompany.com —
  // where the marketing site's /login redirect drops them) would set the cookie
  // there and lose it when Shopify returns to the apex, so the callback finds no
  // state and fails with oauth_failed. Route the whole flow (the domain form and
  // the cookie-minting redirect) through the canonical host once so the cookie
  // and the callback share an origin. The apex proxy presents every request to
  // this server as the app origin, so the marker — not the host comparison
  // alone — is what breaks the self-redirect loop.
  const publicUrl = publicBaseUrl();
  if (publicUrl && !url.searchParams.has(OAUTH_HOST_MARKER)) {
    let canonicalHost: string | null = null;
    try {
      canonicalHost = new URL(publicUrl).host;
    } catch {
      canonicalHost = null;
    }
    if (canonicalHost && url.host !== canonicalHost) {
      const dest = new URL(`${publicUrl}/dashboard/login`);
      if (shop) dest.searchParams.set("shop", shop);
      if (returnTo) dest.searchParams.set("return_to", returnTo);
      dest.searchParams.set(OAUTH_HOST_MARKER, "1");
      return redirect(dest.toString());
    }
  }

  if (!shop) {
    // No store domain yet (direct visit, /login's "Continue with Shopify",
    // connect redirect): ask for it. There is no shop-less authorize endpoint,
    // so the domain must be collected before OAuth can begin. The remembered
    // shop pre-fills the field; return_to rides along as a hidden form field.
    return { mode: "form", returnTo, errorCode: null, shop: null, hintShop } satisfies LoginPageData;
  }

  const state = randomBytes(16).toString("hex");
  const authorizeUrl = buildAuthorizeUrl({
    shop,
    clientId: process.env.SHOPIFY_API_KEY ?? "",
    scopes: process.env.SCOPES ?? "",
    redirectUri: `${publicUrl}/dashboard/auth/callback`,
    state,
  });

  // Pin the state cookie to the real shop (the callback requires an exact
  // match) and carry a validated post-login destination (e.g.
  // /dashboard/connect?t=…) through the round-trip. The return_to is
  // URL-encoded so its query can't collide with the cookie's `:` separators.
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
  // crafted /dashboard/login?shop=... link could plant a 90-day hint.
  return redirect(authorizeUrl, { headers });
}

export default function DashboardLoginPage() {
  const data = useLoaderData<typeof loader>();
  const returnToField = data.returnTo ? (
    <input type="hidden" name="return_to" value={data.returnTo} />
  ) : null;

  if (data.mode === "form") {
    // A plain GET form: the submit re-enters this loader as ?shop=…, which
    // validates the domain and redirects into that shop's Shopify OAuth. Works
    // with JS disabled — no client-side submit handling.
    return (
      <AuthShell>
        <h1 className="cd-auth-title">Connect Shopify</h1>
        <p className="cd-auth-sub">Enter your store to bring it over.</p>
        <form method="get" action="/dashboard/login">
          <label className="cd-auth-label" htmlFor="shop">
            Store domain
          </label>
          <input
            className="cd-auth-input"
            id="shop"
            name="shop"
            type="text"
            inputMode="url"
            placeholder="example.myshopify.com"
            defaultValue={data.hintShop ?? ""}
            autoComplete="on"
            autoFocus
            required
          />
          {returnToField}
          <button className="cd-auth-submit" type="submit">
            Continue
          </button>
        </form>
        <div className="cd-auth-links">
          <a href="/login">Sign in another way</a>
        </div>
      </AuthShell>
    );
  }

  // Bounce-back error. Retry re-enters OAuth with everything the failed attempt
  // carried — the shop (when known; otherwise back to the domain form) and the
  // post-login destination (connector consent).
  const retryParams = new URLSearchParams();
  if (data.shop) retryParams.set("shop", data.shop);
  if (data.returnTo) retryParams.set("return_to", data.returnTo);
  const qs = retryParams.toString();
  const retryHref = qs ? `/dashboard/login?${qs}` : "/dashboard/login";
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
