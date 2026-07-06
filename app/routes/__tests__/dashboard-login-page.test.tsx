// /dashboard/login renders either the store-domain form (form mode, when no
// shop is known yet) or the bounce-back error states (error mode) — both on
// the dashboard design system (AuthShell), never raw JSON. A submitted domain
// re-enters the loader as ?shop= and redirects into per-shop Shopify OAuth.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const loaderDataRef: { current: unknown } = { current: null };
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));

// eslint-disable-next-line import/first
import DashboardLoginPage from "../dashboard.login";

describe("/dashboard/login page", () => {
  it("renders the store-domain form in form mode, prefilled from the remembered shop", () => {
    loaderDataRef.current = { mode: "form", hintShop: "remembered.myshopify.com", returnTo: null, errorCode: null, shop: null };
    const html = renderToStaticMarkup(createElement(DashboardLoginPage));
    expect(html).toContain("cd-auth-card");
    expect(html).toContain('name="shop"');
    expect(html).toContain('action="/dashboard/login"');
    expect(html).toContain('value="remembered.myshopify.com"');
  });

  it("renders no store-domain input in error mode — the retry targets the known shop", () => {
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
