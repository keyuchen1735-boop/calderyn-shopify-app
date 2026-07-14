import type { StorefrontRouteId } from "~/lib/storefront-bundle/types";

export interface StorefrontCacheKeyInput {
  host: string;
  shopId: string;
  bundleId: string;
  artifactHash: string;
  routeId: StorefrontRouteId;
  params: Record<string, string | undefined>;
  catalogRevision: string;
  publicSettingsRevision: string;
}

function stableParams(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

export function buildStorefrontCacheKey(input: StorefrontCacheKeyInput): string {
  return [
    "storefront-v1",
    input.host.toLocaleLowerCase(),
    input.shopId,
    input.bundleId,
    input.artifactHash,
    input.routeId,
    stableParams(input.params),
    input.catalogRevision,
    input.publicSettingsRevision,
  ].join(":");
}

export type StorefrontCacheSurface = StorefrontRouteId | "account" | "policy" | "preview" | "signedMedia";

export function storefrontTenantCacheTag(shopId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shopId)) {
    throw new Error("storefront cache tag requires a UUID shop id");
  }
  return `storefront-shop-${shopId.toLowerCase()}`;
}

export function storefrontCacheHeaders(input: {
  routeId: StorefrontCacheSurface;
  personalized: boolean;
  shopId?: string;
}): Headers {
  const headers = new Headers();
  const publicBrowse = !input.personalized &&
    (input.routeId === "home" || input.routeId === "collection" || input.routeId === "product" || input.routeId === "policy");
  if (publicBrowse) {
    headers.set("Cache-Control", "public, max-age=0, s-maxage=300, stale-while-revalidate=60");
    headers.set("Vary", "Host, Accept-Encoding");
    if (input.shopId) headers.set("Vercel-Cache-Tag", storefrontTenantCacheTag(input.shopId));
  } else {
    headers.set("Cache-Control", "private, no-store");
    headers.set("Vary", "Host, Cookie, Authorization");
  }
  return headers;
}
