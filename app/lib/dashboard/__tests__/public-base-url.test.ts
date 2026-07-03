import { describe, it, expect, afterEach } from "vitest";
import { publicBaseUrl } from "../http.server";

// Regression guard for the prod incident where DASHBOARD_PUBLIC_URL was saved to
// Vercel as an empty string. The old `?? SHOPIFY_APP_URL ?? ""` chain used
// nullish coalescing, which does NOT fall through on "", so the OAuth redirect_uri
// collapsed to a broken *relative* path and Google rejected the sign-in.
describe("publicBaseUrl", () => {
  const savedDash = process.env.DASHBOARD_PUBLIC_URL;
  const savedApp = process.env.SHOPIFY_APP_URL;

  afterEach(() => {
    if (savedDash === undefined) delete process.env.DASHBOARD_PUBLIC_URL;
    else process.env.DASHBOARD_PUBLIC_URL = savedDash;
    if (savedApp === undefined) delete process.env.SHOPIFY_APP_URL;
    else process.env.SHOPIFY_APP_URL = savedApp;
  });

  it("prefers DASHBOARD_PUBLIC_URL when set", () => {
    process.env.DASHBOARD_PUBLIC_URL = "https://calderyncompany.com";
    process.env.SHOPIFY_APP_URL = "https://app.calderyncompany.com";
    expect(publicBaseUrl()).toBe("https://calderyncompany.com");
  });

  it("falls through an EMPTY DASHBOARD_PUBLIC_URL to SHOPIFY_APP_URL (the bug)", () => {
    process.env.DASHBOARD_PUBLIC_URL = "";
    process.env.SHOPIFY_APP_URL = "https://app.calderyncompany.com";
    expect(publicBaseUrl()).toBe("https://app.calderyncompany.com");
  });

  it("falls through a missing DASHBOARD_PUBLIC_URL to SHOPIFY_APP_URL", () => {
    delete process.env.DASHBOARD_PUBLIC_URL;
    process.env.SHOPIFY_APP_URL = "https://app.calderyncompany.com";
    expect(publicBaseUrl()).toBe("https://app.calderyncompany.com");
  });

  it("never returns a value that would build a relative URL when a base is set", () => {
    process.env.DASHBOARD_PUBLIC_URL = "";
    process.env.SHOPIFY_APP_URL = "https://app.calderyncompany.com";
    expect(`${publicBaseUrl()}/dashboard/auth/google/callback`).toMatch(/^https:\/\//);
  });

  it("returns empty string only when neither var is set", () => {
    delete process.env.DASHBOARD_PUBLIC_URL;
    delete process.env.SHOPIFY_APP_URL;
    expect(publicBaseUrl()).toBe("");
  });

  it("trims surrounding whitespace", () => {
    process.env.DASHBOARD_PUBLIC_URL = "  https://calderyncompany.com  ";
    expect(publicBaseUrl()).toBe("https://calderyncompany.com");
  });
});
