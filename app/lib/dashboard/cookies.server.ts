// app/lib/dashboard/cookies.server.ts
//
// Shared cookie names + helpers for the dashboard surface. Every cookie here is
// __Host- prefixed: the browser only accepts it over HTTPS, with Path=/ and no
// Domain, so a sibling subdomain (or a network position on a less-secure host)
// can't inject or fixate it.

import { isValidShopDomain } from "./shopify-oauth.server";

/** Expire a dashboard cookie. Deletion matches on name+path; the remaining
 *  attributes mirror the setters so the __Host- prefix rules stay satisfied. */
export function expireCookieHeader(name: string): string {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/** Shopify-OAuth state nonce for /dashboard/login → /dashboard/auth/callback,
 *  stored as `nonce:shop[:enc(returnTo)]`. */
export const STATE_COOKIE_NAME = "__Host-dash_oauth";

/** Google-signin CSRF nonce for /dashboard/auth/google → its callback. */
export const GOAUTH_COOKIE = "__Host-calderyn_goauth";

// Remembered shop for the Shopify entry (/dashboard/login): pre-fills the store
// domain so a returning Shopify-identity merchant doesn't have to re-type it.
// Set only after a successful OAuth callback (never on an unauthenticated GET —
// a crafted link could otherwise plant it). It no longer triggers any automatic
// redirect into Shopify authorize; sign-in is always an explicit user action.
// Not a secret: constrained to *.myshopify.com, the same trust boundary as ?shop=.
export const SHOP_HINT_COOKIE_NAME = "__Host-dash_shop";
const SHOP_HINT_MAX_AGE = 90 * 86_400; // 90 days

export function shopHintCookieHeader(shop: string): string {
  return `${SHOP_HINT_COOKIE_NAME}=${shop}; Max-Age=${SHOP_HINT_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearShopHintCookieHeader(): string {
  return expireCookieHeader(SHOP_HINT_COOKIE_NAME);
}

export function readShopHint(request: Request): string | null {
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
