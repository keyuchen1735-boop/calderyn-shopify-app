import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "@remix-run/node";
import App, { loader } from "../../root";

vi.mock("@remix-run/react", () => ({
  Links: () => null,
  Meta: () => null,
  Outlet: () => null,
  ScrollRestoration: (props: { nonce?: string }) => createElement("script", { ...props, "data-scroll": true }),
  Scripts: (props: { nonce?: string }) => createElement("script", props),
  useMatches: () => [{ data: { nonce: "checkout-request-nonce" } }],
  useRouteError: () => null,
}));

vi.mock("~/components/dashboard/ErrorBoundary", () => ({
  DashboardErrorFallback: () => null,
}));

describe("root hydration scripts", () => {
  it("uses the storefront request nonce so strict CSP does not block hydration", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('nonce="checkout-request-nonce"');
    expect(html).toContain('data-scroll="true"');
    expect(html.match(/nonce="checkout-request-nonce"/g)).toHaveLength(2);
  });

  it.each([
    "/storefront/checkout",
    "/storefront/checkout/confirmation/token",
    "/storefront/account/cards",
  ])("creates a document nonce for strict CSP path %s", async (pathname) => {
    const response = await loader({
      request: new Request(`https://example.com${pathname}`),
    } as LoaderFunctionArgs);
    await expect(response.json()).resolves.toMatchObject({
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{20,}$/),
    });
  });
});
