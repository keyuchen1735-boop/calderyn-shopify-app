// "Continue with Shopify" is a first-class provider option on the sign-in
// page (not a foot link). It routes a brand-new merchant to account creation
// first (signup mode) so the import intent survives instead of dead-ending on
// an OAuth bounce — see shopifyButtonHref / AuthCard. It still carries
// return_to so the deep-link destination is preserved.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const loaderDataRef: { current: unknown } = { current: null };
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));

// eslint-disable-next-line import/first
import LoginPage from "../login";

const APEX = "https://calderyncompany.com";

describe("/login Shopify provider button", () => {
  it("renders a provider button routing a new merchant to signup on the apex", () => {
    loaderDataRef.current = { error: null, notice: null, email: "", returnTo: null, authBase: APEX };
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain("Continue with Shopify");
    // Absolute apex start URL: any provider/import flow must begin on the apex
    // (where the OAuth __Host- cookie lives), not this app.* origin. Signup mode
    // carries the from=shopify marker so onboarding offers Connect Shopify next.
    expect(html).toContain(`href="${APEX}/signup?from=shopify"`);
    expect(html).not.toContain('href="/signup?from=shopify"');
    // No demoted foot-link variant left behind.
    expect(html).not.toContain("Sign in with Shopify instead");
  });

  it("carries return_to into the Shopify entry like the Google button does", () => {
    loaderDataRef.current = {
      error: null,
      notice: null,
      email: "",
      returnTo: "/dashboard/connect?t=abc",
      authBase: APEX,
    };
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain(
      `href="${APEX}/signup?from=shopify&amp;return_to=${encodeURIComponent("/dashboard/connect?t=abc")}"`,
    );
  });
});
