// app/routes/__tests__/oauth-authorize-ui.test.ts
//
// The interstitial is button-first: a known shop shows the one-click admin
// deep-link button; an unknown shop shows a "Log in with Shopify" button that
// links to /oauth/login (NOT an inline shop text field).
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const fixture = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("react-router", () => ({ useLoaderData: () => fixture.data }));

// eslint-disable-next-line import/first
import AuthorizeInterstitial from "../oauth.authorize";

const BASE = {
  client_name: "Claude",
  token: "tok123",
  apiKey: "apikey123",
  appUrl: "https://app.calderyncompany.com",
  dashboardUrl: "https://calderyncompany.com",
};

function render(data: Record<string, unknown>): string {
  fixture.data = data;
  return renderToString(createElement(AuthorizeInterstitial));
}

describe("/oauth/authorize interstitial", () => {
  it("no shop: renders a 'Sign in with Shopify' link to /oauth/login and NO shop field", () => {
    const html = render({ ...BASE, shop: null });
    expect(html).toContain("Sign in with Shopify");
    expect(html).toContain("https://app.calderyncompany.com/oauth/login?t=tok123");
    expect(html).not.toContain("Enter your shop domain");
    expect(html).not.toContain('name="shop"');
  });

  it("known shop: renders the one-click admin button and no login link", () => {
    const html = render({ ...BASE, shop: "myshop.myshopify.com" });
    expect(html).toContain("Approve in Shopify admin");
    expect(html).not.toContain("/oauth/login?t=");
  });
});
