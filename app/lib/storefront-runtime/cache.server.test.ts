import { describe, expect, it } from "vitest";
import { buildStorefrontCacheKey, storefrontCacheHeaders, storefrontTenantCacheTag } from "./cache.server";

describe("storefront runtime cache policy", () => {
  it("keys public HTML after tenant resolution using bundle, route, catalog, and settings revisions", () => {
    const base = {
      host: "shop.example.com",
      shopId: "shop-a",
      bundleId: "bundle-1",
      artifactHash: "sha256:abc",
      routeId: "product" as const,
      params: { handle: "shoe" },
      catalogRevision: "catalog-7",
      publicSettingsRevision: "settings-3",
    };
    const key = buildStorefrontCacheKey(base);
    expect(key).toContain("shop.example.com");
    expect(key).toContain("shop-a");
    expect(buildStorefrontCacheKey({ ...base, shopId: "shop-b" })).not.toBe(key);
    expect(buildStorefrontCacheKey({ ...base, catalogRevision: "catalog-8" })).not.toBe(key);
  });

  it("keeps cookie-setting browse responses private while allowing neutral policies to cache", () => {
    expect(storefrontCacheHeaders({ routeId: "home", personalized: false }).get("Cache-Control"))
      .toBe("private, no-store");
    expect(storefrontCacheHeaders({ routeId: "policy", personalized: false }).get("Cache-Control"))
      .toBe("public, max-age=0, s-maxage=300, stale-while-revalidate=60");
    for (const routeId of ["collection", "product", "cart", "checkout", "account", "preview", "signedMedia"] as const) {
      const headers = storefrontCacheHeaders({ routeId, personalized: false });
      expect(headers.get("Cache-Control")).toBe("private, no-store");
      expect(headers.get("Vary")).toContain("Cookie");
    }
    expect(storefrontCacheHeaders({ routeId: "product", personalized: true }).get("Cache-Control"))
      .toBe("private, no-store");
  });

  it("tags only cacheable public policy HTML for hard invalidation", () => {
    const shopId = "11111111-1111-4111-8111-111111111111";
    expect(storefrontTenantCacheTag(shopId)).toBe(`storefront-shop-${shopId}`);
    expect(storefrontCacheHeaders({ routeId: "policy", personalized: false, shopId }).get("Vercel-Cache-Tag"))
      .toBe(`storefront-shop-${shopId}`);
    expect(() => storefrontTenantCacheTag("not-a-shop")).toThrow("UUID shop id");
  });

  it("keeps the tracked demo shell private without assigning it a tenant purge tag", () => {
    const headers = storefrontCacheHeaders({ routeId: "home", personalized: false, shopId: "demo-shop" });
    expect(headers.get("Cache-Control")).toBe("private, no-store");
    expect(headers.has("Vercel-Cache-Tag")).toBe(false);
  });
});
