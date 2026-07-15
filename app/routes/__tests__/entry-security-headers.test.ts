import { describe, it, expect, vi } from "vitest";
import { applySecurityHeaders, documentReadyCallbackName } from "../../entry.server";
import { markStorefrontBundleRendered } from "../../lib/storefront-runtime/csp.server";

// entry.server pulls in ./shopify.server, which calls shopifyApp() at module
// load — that throws without SHOPIFY_APP_URL (and inits Prisma session storage),
// failing this suite in CI. Stub the one symbol entry.server needs so
// applySecurityHeaders is testable in isolation. vi.mock is hoisted above the
// imports by vitest, so the stub is in place before entry.server loads (matches
// the shopify.server mock every other route test uses).
vi.mock("../../shopify.server", () => ({
  addDocumentResponseHeaders: () => {},
}));

// The embedded-app iframe depends on the `frame-ancestors` CSP that Shopify's
// addDocumentResponseHeaders sets. applySecurityHeaders runs AFTER that helper
// and must add defense-in-depth directives WITHOUT clobbering frame-ancestors.
const SHOPIFY_CSP =
  "frame-ancestors https://acme.myshopify.com https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;";

describe("document streaming", () => {
  it("waits for all checkout chunks before hydrating the payment form", () => {
    expect(documentReadyCallbackName("/storefront/checkout", null)).toBe("onAllReady");
    expect(documentReadyCallbackName("/storefront/products/shoe", null)).toBe("onShellReady");
  });
});

describe("applySecurityHeaders", () => {
  it("keeps the Shopify frame-ancestors CSP intact (never clobbered)", () => {
    const headers = new Headers({ "Content-Security-Policy": SHOPIFY_CSP });
    applySecurityHeaders(headers);
    const csp = headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain(
      "frame-ancestors https://acme.myshopify.com https://admin.shopify.com",
    );
  });

  it("appends object-src 'none' and base-uri 'self' to the existing CSP", () => {
    const headers = new Headers({ "Content-Security-Policy": SHOPIFY_CSP });
    applySecurityHeaders(headers);
    const csp = headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    // The Shopify hosts must stay in form-action: Chrome enforces it across the
    // store-domain form's redirect chain into Shopify OAuth (silent dead button
    // otherwise).
    expect(csp).toContain(
      "form-action 'self' https://*.myshopify.com https://accounts.shopify.com https://admin.shopify.com",
    );
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("sets the non-CSP defense-in-depth headers", () => {
    const headers = new Headers();
    applySecurityHeaders(headers);
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=(self), browsing-topics=(), usb=(), interest-cohort=()",
    );
    expect(headers.get("X-Permitted-Cross-Domain-Policies")).toBe("none");
    expect(headers.get("X-DNS-Prefetch-Control")).toBe("off");
    expect(headers.get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
    expect(headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin-allow-popups");
    expect(headers.get("Origin-Agent-Cluster")).toBe("?1");
  });

  it("locks framing down on non-embedded surfaces when Shopify set no CSP", () => {
    const headers = new Headers();
    applySecurityHeaders(headers, "/dashboard/signin");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    const csp = headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // Must never invent a document-wide script-src/default-src: that would break
    // inline hydration on the dashboard/storefront.
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("default-src");
  });

  it("installs the storefront-specific nonce CSP without affecting dashboard policy", () => {
    const storefront = new Headers();
    markStorefrontBundleRendered(storefront);
    applySecurityHeaders(storefront, "/storefront/products/shoe", "request-nonce");
    expect(storefront.get("Content-Security-Policy") ?? "").toContain("script-src 'self' 'nonce-request-nonce'");
    expect(storefront.get("Content-Security-Policy") ?? "").toContain("connect-src 'self'");

    const dashboard = new Headers();
    applySecurityHeaders(dashboard, "/dashboard", "request-nonce");
    expect(dashboard.get("Content-Security-Policy") ?? "").not.toContain("script-src");
  });

  it("keeps legacy browse compatible while giving checkout and account cards Stripe CSP", () => {
    const legacyBrowse = new Headers();
    applySecurityHeaders(legacyBrowse, "/storefront/products/shoe", "request-nonce");
    expect(legacyBrowse.get("Content-Security-Policy") ?? "").not.toContain("script-src");

    for (const path of ["/storefront/checkout", "/storefront/account/cards"]) {
      const headers = new Headers();
      applySecurityHeaders(headers, path, "request-nonce");
      expect(headers.get("Content-Security-Policy") ?? "").toContain("https://js.stripe.com");
    }
  });

  it("allows same-origin framing on the studio draft-preview path (not DENY)", () => {
    // The Store studio iframes /dashboard/store/preview; DENY would blank it.
    const headers = new Headers();
    applySecurityHeaders(headers, "/dashboard/store/preview");
    expect(headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    const csp = headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
    // First-party scripts run here: the preview displays sanitized store HTML and
    // hydrates the shader/motion effect runtimes, plus Remix's inline hydration.
    // Model script is stripped by the sanitizer and remote script stays blocked,
    // so the policy is self + inline only and the old blanket 'none' is gone.
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("script-src 'none'");
    // Still hardened like every other non-embedded surface.
    expect(csp).toContain("object-src 'none'");
  });

  it("does NOT extend the framing exemption to child paths under the preview", () => {
    // The exemption is anchored to the exact path — a future nested route must
    // fall back to the default DENY / frame-ancestors 'none', not inherit it.
    const headers = new Headers();
    applySecurityHeaders(headers, "/dashboard/store/preview/anything");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Content-Security-Policy") ?? "").toContain("frame-ancestors 'none'");
  });

  it("leaves embedded-path framing untouched even with no Shopify CSP", () => {
    // Shopify frames /app and /auth; setting X-Frame-Options or frame-ancestors
    // 'none' on an embedded error response would break the admin iframe.
    const headers = new Headers();
    applySecurityHeaders(headers, "/app/settings");
    expect(headers.get("X-Frame-Options")).toBeNull();
    expect(headers.get("Content-Security-Policy")).toBeNull();
  });

  it("is idempotent — re-running does not duplicate appended directives", () => {
    const headers = new Headers({ "Content-Security-Policy": SHOPIFY_CSP });
    applySecurityHeaders(headers);
    applySecurityHeaders(headers);
    const csp = headers.get("Content-Security-Policy") ?? "";
    expect(csp.match(/object-src 'none'/g)?.length).toBe(1);
    expect(csp.match(/base-uri 'self'/g)?.length).toBe(1);
    expect(csp.match(/form-action 'self'/g)?.length).toBe(1);
    expect(csp.match(/upgrade-insecure-requests/g)?.length).toBe(1);
  });

  it("removes common framework disclosure headers", () => {
    const headers = new Headers({ Server: "example", "X-Powered-By": "Express" });
    applySecurityHeaders(headers);
    expect(headers.get("Server")).toBeNull();
    expect(headers.get("X-Powered-By")).toBeNull();
  });
});
