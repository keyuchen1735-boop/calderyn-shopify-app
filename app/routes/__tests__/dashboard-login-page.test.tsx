// The store-domain page is the "Continue with Shopify" landing — it must render
// with the dashboard design system (AuthShell), carry return_to, and surface
// error states as friendly copy instead of raw JSON.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const loaderDataRef: { current: unknown } = { current: null };
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));

// eslint-disable-next-line import/first
import DashboardLoginPage from "../dashboard.login";

describe("/dashboard/login page", () => {
  it("renders the store-domain form on the auth card, pre-filled from the hint", () => {
    loaderDataRef.current = { mode: "form", hintShop: "myshop.myshopify.com", returnTo: "/dashboard/connect?t=abc", errorCode: null };
    const html = renderToStaticMarkup(createElement(DashboardLoginPage));
    expect(html).toContain("cd-auth-card");
    expect(html).toContain('name="shop"');
    expect(html).toContain('value="myshop.myshopify.com"');
    expect(html).toContain('name="return_to"');
    expect(html).toContain('value="/dashboard/connect?t=abc"');
    expect(html).not.toContain("#5b3df5"); // the off-brand inline style is gone
  });

  it("renders the app_not_installed error with install guidance and no retry loop", () => {
    loaderDataRef.current = { mode: "error", hintShop: null, returnTo: null, errorCode: "app_not_installed", shop: "myshop.myshopify.com" };
    const html = renderToStaticMarkup(createElement(DashboardLoginPage));
    expect(html).toContain("cd-auth-banner--error");
    expect(html).toContain("Install the Calderyn app");
    expect(html).toContain("Try again"); // retry link back into the form
  });

  it("renders oauth_failed with a retry link for the known shop", () => {
    loaderDataRef.current = { mode: "error", hintShop: null, returnTo: null, errorCode: "oauth_failed", shop: "myshop.myshopify.com" };
    const html = renderToStaticMarkup(createElement(DashboardLoginPage));
    expect(html).toContain("cd-auth-banner--error");
    expect(html).toContain("/dashboard/login?shop=myshop.myshopify.com");
  });
});
