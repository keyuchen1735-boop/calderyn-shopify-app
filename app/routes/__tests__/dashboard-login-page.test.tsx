// /dashboard/login GETs 302 into Shopify OAuth, so this component only ever
// renders the bounce-back error states (oauth_failed, app_not_installed,
// invalid_shop) on the dashboard design system (AuthShell), never raw JSON.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const loaderDataRef: { current: unknown } = { current: null };
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));

// eslint-disable-next-line import/first
import DashboardLoginPage from "../dashboard.login";

describe("/dashboard/login page", () => {
  it("renders no store-domain input — the retry targets the known shop", () => {
    loaderDataRef.current = { mode: "error", hintShop: null, returnTo: null, errorCode: "oauth_failed", shop: null };
    const html = renderToStaticMarkup(createElement(DashboardLoginPage));
    expect(html).toContain("cd-auth-card");
    expect(html).not.toContain('name="shop"');
  });

  it("renders the app_not_installed error as a retryable setup failure, not an install ask", () => {
    loaderDataRef.current = { mode: "error", returnTo: null, errorCode: "app_not_installed", shop: "myshop.myshopify.com" };
    const html = renderToStaticMarkup(createElement(DashboardLoginPage));
    expect(html).toContain("cd-auth-banner--error");
    // The code fires after a successful grant when our side couldn't finish —
    // telling the merchant to go install the app would be wrong twice over.
    expect(html).toContain("finish setting it up");
    expect(html).toContain("Try again");
  });

  it("renders oauth_failed with a retry link for the known shop", () => {
    loaderDataRef.current = { mode: "error", returnTo: null, errorCode: "oauth_failed", shop: "myshop.myshopify.com" };
    const html = renderToStaticMarkup(createElement(DashboardLoginPage));
    expect(html).toContain("cd-auth-banner--error");
    expect(html).toContain("/dashboard/login?shop=myshop.myshopify.com");
  });

  it("carries the connector destination through the retry link", () => {
    loaderDataRef.current = { mode: "error", returnTo: "/dashboard/connect?t=abc", errorCode: "oauth_failed", shop: null };
    const html = renderToStaticMarkup(createElement(DashboardLoginPage));
    expect(html).toContain(`return_to=${encodeURIComponent("/dashboard/connect?t=abc").replace(/&/g, "&amp;")}`);
  });

  it("renders invalid_shop with domain-format guidance", () => {
    loaderDataRef.current = { mode: "error", hintShop: null, returnTo: null, errorCode: "invalid_shop", shop: null };
    const html = renderToStaticMarkup(createElement(DashboardLoginPage));
    expect(html).toContain("cd-auth-banner--error");
    // Substring starts after the apostrophe in "store's" (React HTML-escapes it).
    expect(html).toContain(".myshopify.com domain, like example.myshopify.com");
  });
});
