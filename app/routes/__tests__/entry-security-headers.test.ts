import { describe, it, expect } from "vitest";
import { applySecurityHeaders } from "../../entry.server";

// The embedded-app iframe depends on the `frame-ancestors` CSP that Shopify's
// addDocumentResponseHeaders sets. applySecurityHeaders runs AFTER that helper
// and must add defense-in-depth directives WITHOUT clobbering frame-ancestors.
const SHOPIFY_CSP =
  "frame-ancestors https://acme.myshopify.com https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;";

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
  });

  it("sets the non-CSP defense-in-depth headers", () => {
    const headers = new Headers();
    applySecurityHeaders(headers);
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=(), browsing-topics=()",
    );
    expect(headers.get("X-Permitted-Cross-Domain-Policies")).toBe("none");
  });

  it("does not add a CSP when Shopify set none (non-embedded edge: leave as-is)", () => {
    // When there is no CSP to augment, we must NOT invent a document-wide one
    // (script-src would break App Bridge). Absence stays absence.
    const headers = new Headers();
    applySecurityHeaders(headers);
    expect(headers.get("Content-Security-Policy")).toBeNull();
  });

  it("is idempotent — re-running does not duplicate appended directives", () => {
    const headers = new Headers({ "Content-Security-Policy": SHOPIFY_CSP });
    applySecurityHeaders(headers);
    applySecurityHeaders(headers);
    const csp = headers.get("Content-Security-Policy") ?? "";
    expect(csp.match(/object-src 'none'/g)?.length).toBe(1);
    expect(csp.match(/base-uri 'self'/g)?.length).toBe(1);
  });
});
