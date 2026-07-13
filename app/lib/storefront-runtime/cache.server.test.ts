import { describe, expect, it } from "vitest";
import { buildStorefrontCacheKey, storefrontCacheHeaders } from "./cache.server";

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

  it("allows neutral public browse caching and forces personalized surfaces private no-store", () => {
    expect(storefrontCacheHeaders({ routeId: "home", personalized: false }).get("Cache-Control"))
      .toBe("public, max-age=0, s-maxage=300, stale-while-revalidate=60");
    for (const routeId of ["cart", "checkout", "account", "preview", "signedMedia"] as const) {
      const headers = storefrontCacheHeaders({ routeId, personalized: false });
      expect(headers.get("Cache-Control")).toBe("private, no-store");
      expect(headers.get("Vary")).toContain("Cookie");
    }
    expect(storefrontCacheHeaders({ routeId: "product", personalized: true }).get("Cache-Control"))
      .toBe("private, no-store");
  });
});
