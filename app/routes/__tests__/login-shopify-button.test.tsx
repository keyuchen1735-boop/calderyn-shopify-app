// "Continue with Shopify" is a first-class provider option on the sign-in
// page (not a foot link). Since the signup+import rerouting, it sends new
// visitors to account creation with the Shopify marker (import follows in
// onboarding) instead of starting OAuth cold, and must still carry return_to.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const loaderDataRef: { current: unknown } = { current: null };
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));

// eslint-disable-next-line import/first
import LoginPage from "../login";

const APEX = "https://calderyncompany.com";

describe("/login Shopify provider button", () => {
  it("renders a provider button routing to signup with the shopify marker on the apex", () => {
    loaderDataRef.current = { error: null, notice: null, email: "", returnTo: null, authBase: APEX };
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain("Continue with Shopify");
    // Absolute apex URL: signup (and the OAuth flow it leads into) lives on
    // the public apex, not this app.* origin.
    expect(html).toContain(`href="${APEX}/signup?from=shopify"`);
    expect(html).not.toContain('href="/signup?from=shopify"');
    // The cold OAuth start is no longer the button target for new visitors.
    expect(html).not.toContain(`href="${APEX}/dashboard/login"`);
    // No demoted foot-link variant left behind.
    expect(html).not.toContain("Sign in with Shopify instead");
  });

  it("carries return_to into the signup entry like the Google button does", () => {
    loaderDataRef.current = {
      error: null,
      notice: null,
      email: "",
      returnTo: "/dashboard/connect?t=abc",
      authBase: APEX,
    };
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain(
      `href="${APEX}/signup?from=shopify&amp;return_to=${encodeURIComponent("/dashboard/connect?t=abc").replace(/&/g, "&amp;")}"`,
    );
  });
});
