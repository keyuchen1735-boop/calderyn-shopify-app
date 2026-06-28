// app/lib/storefront/shop.server.ts
// Resolves an incoming public storefront request to an internal shop_id. This is
// the unauthenticated, multi-tenant entry posture; the resolved shopId is then
// passed as the first argument of every catalog read (manual scoping).
export const DEMO_SHOP_ID = "demo-shop";

/** Derive the tenant slug: ?shop= (dev fallback) wins, else the host subdomain. */
export function storefrontSlug(request: Request): string {
  const url = new URL(request.url);
  const fromParam = url.searchParams.get("shop");
  if (fromParam) return fromParam.toLowerCase();
  const host = request.headers.get("host") ?? url.host;
  return host.split(":")[0].split(".")[0].toLowerCase();
}

export async function resolveStorefrontShop(request: Request): Promise<string> {
  const slug = storefrontSlug(request);
  // ponytail: single-tenant fixture pilot — an explicit (currently single-entry)
  // registry maps the demo slug to the one demo shop_id, and every other slug also
  // falls back to it, so the shell renders with no shops table / no DB. Upgrade:
  // replace the fallback with resolveShopId(`${slug}.myshopify.com`) once the hosting
  // module attaches real subdomains (app/lib/supabase.server.ts:37).
  const known: Record<string, string> = { demo: DEMO_SHOP_ID };
  return known[slug] ?? DEMO_SHOP_ID;
}
