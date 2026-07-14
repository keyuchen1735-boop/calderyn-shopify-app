import { describe, expect, it } from "vitest";
import {
  buildStorefrontCsp,
  isStorefrontBundleReadEnabled,
  isStorefrontDocumentPath,
  markStorefrontBundleRendered,
  resolveStorefrontBundleNonce,
  resolveStorefrontCspSurface,
  stripStorefrontRendererHeader,
} from "./csp.server";

const trustedMedia = {
  supabaseUrl: "https://project.supabase.co",
  ownedMediaOrigin: "https://media.calderyncompany.com",
};

describe("storefront document CSP", () => {
  it("carries the route renderer nonce into entry.server and strips the internal header", () => {
    const headers = new Headers();
    markStorefrontBundleRendered(headers, "route-owned-nonce");
    expect(resolveStorefrontBundleNonce(headers)).toBe("route-owned-nonce");
    stripStorefrontRendererHeader(headers);
    expect(headers.has("X-Calderyn-Storefront-Nonce")).toBe(false);
  });

  it("allows exact trusted live-media origins without arbitrary HTTPS", () => {
    const csp = buildStorefrontCsp({ nonce: "nonce-value", surface: "browse", ...trustedMedia });
    expect(csp).toContain("'nonce-nonce-value'");
    expect(csp).toContain("https://project.supabase.co");
    expect(csp).toContain("https://media.calderyncompany.com");
    expect(csp).toContain("https://cdn.shopify.com");
    expect(csp).not.toMatch(/img-src[^;]*\shttps:\s/);
    expect(csp).not.toContain("media.example");
    expect(csp).not.toContain("stripe.com");
  });

  it.each(["checkout", "accountCards"] as const)("adds Stripe requirements only to %s", (surface) => {
    const csp = buildStorefrontCsp({ nonce: "stripe-route", surface, ...trustedMedia });
    expect(csp).toContain("https://js.stripe.com");
    expect(csp).toContain("https://api.stripe.com");
    expect(csp).toContain("https://hooks.stripe.com");
  });

  it("selects strict policy from the actual response renderer and sensitive platform route", () => {
    const legacy = new Headers();
    expect(resolveStorefrontCspSurface(legacy, "/storefront/products/shoe")).toBeNull();
    markStorefrontBundleRendered(legacy);
    expect(resolveStorefrontCspSurface(legacy, "/storefront/products/shoe")).toBe("browse");
    expect(resolveStorefrontCspSurface(new Headers(), "/storefront/checkout")).toBe("checkout");
    expect(resolveStorefrontCspSurface(new Headers(), "/storefront/account/cards")).toBe("accountCards");
    expect(resolveStorefrontCspSurface(new Headers(), "/storefront/account")).toBeNull();
  });

  it("recognizes documents and uses only the documented bundle read flag", () => {
    expect(isStorefrontDocumentPath("/storefront/products/shoe")).toBe(true);
    expect(isStorefrontDocumentPath("/storefront/api/cart")).toBe(false);
    expect(isStorefrontBundleReadEnabled(undefined)).toBe(false);
    expect(isStorefrontBundleReadEnabled("0")).toBe(false);
    expect(isStorefrontBundleReadEnabled("true")).toBe(true);
  });
});
