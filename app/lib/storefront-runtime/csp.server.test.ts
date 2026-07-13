import { describe, expect, it } from "vitest";
import { buildStorefrontCsp, isRuntime1StorefrontReadEnabled, isStorefrontDocumentPath } from "./csp.server";

describe("storefront document CSP", () => {
  it("locks generated routes to first-party assets and nonce-authorized runtime code", () => {
    const csp = buildStorefrontCsp({ nonce: "nonce-value", checkout: false });
    for (const directive of [
      "script-src", "style-src", "connect-src", "font-src", "img-src", "frame-src", "object-src",
      "worker-src", "form-action", "base-uri",
    ]) expect(csp).toContain(`${directive} `);
    expect(csp).toContain("'nonce-nonce-value'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("stripe.com");
  });

  it("adds only the Stripe origins needed by checkout", () => {
    const csp = buildStorefrontCsp({ nonce: "checkout", checkout: true });
    expect(csp).toContain("https://js.stripe.com");
    expect(csp).toContain("https://api.stripe.com");
    expect(csp).toContain("https://hooks.stripe.com");
  });

  it("recognizes public storefront documents without matching APIs or dashboard previews", () => {
    expect(isStorefrontDocumentPath("/storefront/products/shoe")).toBe(true);
    expect(isStorefrontDocumentPath("/storefront/checkout")).toBe(true);
    expect(isStorefrontDocumentPath("/storefront/api/cart")).toBe(false);
    expect(isStorefrontDocumentPath("/dashboard/store/preview")).toBe(false);
  });

  it("keeps the stricter document policy behind the runtime-1 read flag", () => {
    expect(isRuntime1StorefrontReadEnabled(undefined)).toBe(false);
    expect(isRuntime1StorefrontReadEnabled("0")).toBe(false);
    expect(isRuntime1StorefrontReadEnabled("true")).toBe(true);
    expect(isRuntime1StorefrontReadEnabled("1")).toBe(true);
  });
});
