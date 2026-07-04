// "Continue with Shopify" is a first-class provider option on the sign-in
// page (not a foot link) and must carry return_to into the OAuth entry.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const loaderDataRef: { current: unknown } = { current: null };
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));

// eslint-disable-next-line import/first
import LoginPage from "../login";

const APEX = "https://calderyncompany.com";

describe("/login Shopify provider button", () => {
  it("renders a provider button starting the Shopify OAuth flow on the apex", () => {
    loaderDataRef.current = { error: null, notice: null, email: "", returnTo: null, authBase: APEX };
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain("Continue with Shopify");
    // Absolute apex start URL: the __Host- state cookie must be set on the same
    // host the OAuth callback lands on, not this app.* origin (a bare relative
    // href would drop the cookie and fail the callback state check).
    expect(html).toContain(`href="${APEX}/dashboard/login"`);
    expect(html).not.toContain('href="/dashboard/login"');
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
      `href="${APEX}/dashboard/login?return_to=${encodeURIComponent("/dashboard/connect?t=abc").replace(/&/g, "&amp;")}"`,
    );
  });
});
