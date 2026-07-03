// "Continue with Shopify" is a first-class provider option on the sign-in
// page (not a foot link) and must carry return_to into the OAuth entry.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const loaderDataRef: { current: unknown } = { current: null };
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));

// eslint-disable-next-line import/first
import LoginPage from "../login";

describe("/login Shopify provider button", () => {
  it("renders a provider button linking to /dashboard/login", () => {
    loaderDataRef.current = { error: null, notice: null, email: "", returnTo: null };
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain("Continue with Shopify");
    expect(html).toContain('href="/dashboard/login"');
    // No demoted foot-link variant left behind.
    expect(html).not.toContain("Sign in with Shopify instead");
  });

  it("carries return_to into the Shopify entry like the Google button does", () => {
    loaderDataRef.current = { error: null, notice: null, email: "", returnTo: "/dashboard/connect?t=abc" };
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain(
      `href="/dashboard/login?return_to=${encodeURIComponent("/dashboard/connect?t=abc").replace(/&/g, "&amp;")}"`,
    );
  });
});
