// app/lib/storefront/shop.server.ts
// Resolves an incoming public storefront request to an internal shop_id. This is
// the unauthenticated, multi-tenant entry posture; the resolved shopId is then
// passed as the first argument of every catalog read (manual scoping).
import { getSupabase } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";
import { tenantDomain } from "./vercel-domain.server";

export const DEMO_SHOP_ID = "demo-shop";

// Host labels only: anything else is not a routable tenant slug and gets the demo shell
// (also keeps attacker-shaped slugs out of the DB filter below).
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Slugs that are never tenants: the demo shell, the platform's own hosts, and local dev.
const FIXTURE_SLUGS = new Set(["demo", "app", "www", "calderyncompany", "localhost"]);

// Short-TTL cache for hits AND misses. slug -> shop ownership CAN change (org_slug
// rename, uninstall + GDPR delete + reinstall under a new id), so entries expire
// instead of living for the process; the size cap keeps a Host-header sweep from
// growing the map without bound.
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1_000;
const slugCache = new Map<string, { id: string | null; expiresAt: number }>();

/** Drop every cached slug resolution (shop uninstall/rename hooks, tests). */
export function clearStorefrontShopCache(): void {
  slugCache.clear();
}

/** This shop's public storefront origin (https://<slug>.calderyncompany.com), or
 *  "" for a demo/non-uuid shop or one with no org_slug yet (no live storefront).
 *  Used by the dashboard to show a merchant their real sitemap/robots URLs. */
export async function getShopStorefrontOrigin(shopId: string): Promise<string> {
  if (!isUuid(shopId)) return "";
  const { data, error } = await getSupabase().from("shops").select("org_slug").eq("id", shopId).maybeSingle();
  if (error) throw error;
  const slug = typeof data?.org_slug === "string" ? data.org_slug.trim() : "";
  return slug ? `https://${tenantDomain(slug)}` : "";
}

/** Derive the tenant slug: ?shop= (dev fallback) wins, else the host subdomain. */
export function storefrontSlug(request: Request): string {
  const url = new URL(request.url);
  const fromParam = url.searchParams.get("shop");
  // ?shop= is a DEV-only override; in production the host alone selects the tenant, so an
  // attacker-supplied query param can never pick another shop on this public surface.
  if (fromParam && process.env.NODE_ENV !== "production") return fromParam.toLowerCase();
  const host = request.headers.get("host") ?? url.host;
  return host.split(":")[0].split(".")[0].toLowerCase();
}

async function lookupShopId(slug: string): Promise<string | null> {
  // One roundtrip covers both identities; slug is SLUG_RE-validated, so it cannot
  // smuggle PostgREST filter syntax into the or(). Uninstalled shops do not resolve
  // (same posture as the resolver in admin-deeplink.server.ts).
  const { data, error } = await getSupabase()
    .from("shops")
    .select("id, org_slug")
    .or(`org_slug.eq.${slug},shop_domain.eq.${slug}.myshopify.com`)
    .is("uninstalled_at", null)
    .limit(2);
  if (error) throw error;
  if (!data || data.length === 0) return null;
  // Owned identity wins when a native org_slug and a myshopify handle collide.
  const native = data.find((row) => row.org_slug === slug);
  return String((native ?? data[0]).id);
}

/**
 * The real tenant shop for this request's host, or null when the host is a
 * platform/fixture host or the slug matches no live shop. Lets callers
 * distinguish "an actual store's domain" from "something that merely falls
 * back to the demo shell" (e.g. the root route deciding whether the homepage
 * is a storefront).
 */
export async function resolveTenantShopId(request: Request): Promise<string | null> {
  const slug = storefrontSlug(request);
  if (FIXTURE_SLUGS.has(slug) || !SLUG_RE.test(slug)) return null;

  const cached = slugCache.get(slug);
  if (cached && cached.expiresAt > Date.now()) return cached.id;

  const id = await lookupShopId(slug);
  if (slugCache.size >= CACHE_MAX_ENTRIES) {
    // FIFO-evict the oldest entry (Map preserves insertion order) so a Host-header
    // sweep displaces one entry at a time instead of wiping every hot tenant.
    const oldest = slugCache.keys().next().value;
    if (oldest !== undefined) slugCache.delete(oldest);
  }
  slugCache.set(slug, { id, expiresAt: Date.now() + CACHE_TTL_MS });

  return id;
}

export async function resolveStorefrontShop(request: Request): Promise<string> {
  // Unknown slug: render the demo shell rather than blanking the storefront.
  return (await resolveTenantShopId(request)) ?? DEMO_SHOP_ID;
}
