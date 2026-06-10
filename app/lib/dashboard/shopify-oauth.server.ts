// app/lib/dashboard/shopify-oauth.server.ts
//
// Standalone Shopify OAuth for the web dashboard. We run the code grant only
// to PROVE the requester controls the shop — the embedded app already holds
// offline tokens, so the access token returned here is discarded.

import { createHmac, timingSafeEqual } from "node:crypto";

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN_RE.test(shop);
}

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

/** Returns true if Shopify accepted the code (token is discarded on purpose). */
export async function exchangeCodeForToken(opts: {
  shop: string;
  code: string;
  clientId: string;
  clientSecret: string;
}): Promise<boolean> {
  const res = await fetch(`https://${opts.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
    }),
  });
  return res.ok;
}
