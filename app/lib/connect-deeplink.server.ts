// app/lib/connect-deeplink.server.ts
//
// Server-only: the remembered-shop hint cookie for the connector authorize
// origin (app.calderyncompany.com). Host-scoped (__Host- prefix) so /oauth/authorize
// can READ it and /oauth/login can WRITE it on the same host. This is NOT
// consumable OAuth state — it is the same trust level as the ?shop= query hint
// (mirrors the dashboard's __Host-dash_shop). /oauth/authorize must never
// Set-Cookie (the no-pre-seed invariant from PR #107); only /oauth/login writes.

import { SHOP_RE } from "./connect-deeplink";

export const SHOP_HINT_COOKIE_NAME = "__Host-cala_shop";
const MAX_AGE = 90 * 86_400; // 90 days

export function readShopHintCookie(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SHOP_HINT_COOKIE_NAME) {
      const value = rest.join("=").trim().toLowerCase();
      return SHOP_RE.test(value) ? value : null;
    }
  }
  return null;
}

export function shopHintCookieHeader(shop: string): string {
  return `${SHOP_HINT_COOKIE_NAME}=${shop}; Max-Age=${MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
