// app/lib/dashboard/shopify-oauth.server.ts
//
// Standalone Shopify OAuth for the web dashboard. The code grant proves the
// requester controls the shop AND yields the offline token the import
// pipeline runs on — for shops connecting here first (never opened the
// embedded app), this grant IS the install.

import { createHmac, timingSafeEqual } from "node:crypto";

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN_RE.test(shop);
}

/**
 * Coerces merchant-typed store input into a candidate shop domain. Handles the
 * shapes a merchant actually types — a bare handle ("acme"), the full domain,
 * or a pasted "https://acme.myshopify.com/…" URL (scheme + path stripped) — but
 * does NOT itself validate: the caller must still run isValidShopDomain, so a
 * non-myshopify value ("evil.com") is passed through unchanged and rejected
 * downstream.
 */
export function normalizeShopInput(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "") // drop a pasted scheme
    .replace(/\/.*$/, ""); // drop any path/query
  // A bare handle (no dot) is the store name — complete it.
  return s && !s.includes(".") ? `${s}.myshopify.com` : s;
}

// Shopify's authorization code grant is per-shop
// (https://{shop}/admin/oauth/authorize) and there is no shop-less authorize
// endpoint — so the shop is always known here (collected at /dashboard/login).
// The per-shop endpoint enforces the app's registered redirect_urls.
export function buildAuthorizeUrl(opts: {
  shop: string;
  clientId: string;
  scopes: string;
  redirectUri: string;
  state: string;
}): string {
  const sp = new URLSearchParams({
    client_id: opts.clientId,
    scope: opts.scopes,
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `https://${opts.shop}/admin/oauth/authorize?${sp.toString()}`;
}

/**
 * Shopify signs callback query strings: HMAC-SHA256 over the params (minus
 * `hmac`), sorted by key, joined `k=v` with `&`, keyed by the app secret.
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 */
export function verifyShopifyHmac(params: URLSearchParams, secret: string): boolean {
  const provided = params.get("hmac");
  if (!provided) return false;
  const message = [...params.entries()]
    .filter(([k]) => k !== "hmac")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface OfflineTokenGrant {
  accessToken: string;
  scope: string;
  /** Seconds until the token expires — present when the app uses expiring offline tokens. */
  expiresIn: number | null;
  refreshToken: string | null;
  refreshTokenExpiresIn: number | null;
}

/**
 * Exchanges the code for the shop's offline token; null if Shopify refused or
 * the endpoint stalled (bounded so a Shopify outage fails fast onto the
 * friendly error page instead of burning the one-shot code on a 504).
 */
export async function exchangeCodeForToken(opts: {
  shop: string;
  code: string;
  clientId: string;
  clientSecret: string;
}): Promise<OfflineTokenGrant | null> {
  let res: Response;
  try {
    res = await fetch(`https://${opts.shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        code: opts.code,
        // Match the embedded flow's expiringOfflineAccessTokens: without this
        // Shopify mints a legacy non-expiring token, which new public apps
        // can't use for background Admin calls (403, enforced 2026-04-01).
        expiring: "1",
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    scope?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
  } | null;
  if (!body?.access_token) return null;
  return {
    accessToken: body.access_token,
    scope: body.scope ?? "",
    expiresIn: body.expires_in ?? null,
    refreshToken: body.refresh_token ?? null,
    refreshTokenExpiresIn: body.refresh_token_expires_in ?? null,
  };
}
