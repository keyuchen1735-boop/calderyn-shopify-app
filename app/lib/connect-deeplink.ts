// app/lib/connect-deeplink.ts
//
// Shared, isomorphic helpers for the Claude.ai MCP connector sign-in. Building
// the embedded /app/connect deep link is needed by BOTH the authorize
// interstitial (oauth.authorize.tsx) and the cold-path login page
// (oauth.login.tsx), so it lives here instead of being duplicated.

export const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

export interface BuildConnectUrlOpts {
  shop: string | null;
  apiKey: string;
  appUrl: string;
  token: string;
}

// When we know the shop, an admin.shopify.com deep link is the most reliable
// carrier: Shopify admin preserves its own URLs through login, so the ?t= token
// survives an unauthenticated landing. Otherwise fall back to the app URL and let
// the app's standard auth resolve the shop.
export function buildAppConnectUrl({ shop, apiKey, appUrl, token }: BuildConnectUrlOpts): string {
  const t = encodeURIComponent(token);
  if (shop && SHOP_RE.test(shop) && apiKey) {
    const handle = shop.replace(/\.myshopify\.com$/i, "");
    return `https://admin.shopify.com/store/${handle}/apps/${apiKey}/app/connect?t=${t}`;
  }
  return `${appUrl}/app/connect?t=${t}`;
}
