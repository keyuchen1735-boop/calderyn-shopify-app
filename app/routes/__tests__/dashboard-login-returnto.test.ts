// app/routes/__tests__/dashboard-login-returnto.test.ts
//
// The connector consent flow carries a post-login destination through the
// Shopify OAuth round-trip. That destination is attacker-influenced (?return_to=
// in a link Claude.ai opens), so the guard against open redirects is the
// security-critical part here.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as ShopifyOauthMod from "~/lib/dashboard/shopify-oauth.server";
import type * as HttpMod from "~/lib/dashboard/http.server";

const rateLimit = vi.fn((..._a: unknown[]) => true);
const buildAuthorizeUrl = vi.fn((..._a: unknown[]) => "https://admin.shopify.com/authorize");

vi.mock("~/lib/dashboard/shopify-oauth.server", async (importOriginal) => ({
  ...(await importOriginal<typeof ShopifyOauthMod>()),
  buildAuthorizeUrl: (...a: unknown[]) => buildAuthorizeUrl(...a),
}));
vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof HttpMod>()),
  rateLimit: (...a: unknown[]) => rateLimit(...a),
}));

// eslint-disable-next-line import/first
import { loader } from "../dashboard.login";
// eslint-disable-next-line import/first
import { safeDashboardReturnTo } from "~/lib/dashboard/http.server";

describe("safeDashboardReturnTo", () => {
  it("accepts a same-origin dashboard path", () => {
    expect(safeDashboardReturnTo("/dashboard/connect?t=abc")).toBe("/dashboard/connect?t=abc");
  });

  it("rejects absolute URLs, protocol-relative, and backslash tricks", () => {
    expect(safeDashboardReturnTo("https://evil.example/x")).toBeNull();
    expect(safeDashboardReturnTo("//evil.example/x")).toBeNull();
    expect(safeDashboardReturnTo("/dashboard/\\evil")).toBeNull();
    expect(safeDashboardReturnTo("/dashboard/x?u=https://evil")).toBeNull();
    expect(safeDashboardReturnTo("/other/path")).toBeNull();
    expect(safeDashboardReturnTo(null)).toBeNull();
  });

  it("rejects control characters (CRLF header-injection guard)", () => {
    const LF = String.fromCharCode(10), CR = String.fromCharCode(13), TAB = String.fromCharCode(9);
    expect(safeDashboardReturnTo("/dashboard/connect" + LF + "X-Evil: 1")).toBeNull();
    expect(safeDashboardReturnTo("/dashboard/connect" + CR + LF + "Set-Cookie: a=b")).toBeNull();
    expect(safeDashboardReturnTo("/dashboard/x" + TAB)).toBeNull();
    // a plain space is NOT a control char - still allowed.
    expect(safeDashboardReturnTo("/dashboard/a b")).toBe("/dashboard/a b");
  });
});

describe("/dashboard/login carries a validated return_to into the state cookie", () => {
  beforeEach(() => {
    rateLimit.mockReturnValue(true);
    buildAuthorizeUrl.mockReturnValue("https://admin.shopify.com/authorize");
    process.env.SHOPIFY_API_KEY = "apikey";
    process.env.SCOPES = "read_products";
    process.env.DASHBOARD_PUBLIC_URL = "https://app.calderyncompany.com";
  });

  function req(url: string): { request: Request } {
    return { request: new Request(url) };
  }

  it("encodes a valid return_to as the third state-cookie field", async () => {
    const r = (await loader(
      req(
        "https://app.calderyncompany.com/dashboard/login?shop=myshop.myshopify.com&return_to=%2Fdashboard%2Fconnect%3Ft%3Dabc",
      ) as never,
    )) as Response;
    expect(r.status).toBe(302);
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-dash_oauth=");
    // state:shop:enc(returnTo)
    expect(cookie).toContain(`:myshop.myshopify.com:${encodeURIComponent("/dashboard/connect?t=abc")}`);
  });

  it("omits the return_to field when it is an unsafe redirect", async () => {
    const r = (await loader(
      req(
        "https://app.calderyncompany.com/dashboard/login?shop=myshop.myshopify.com&return_to=https%3A%2F%2Fevil.example",
      ) as never,
    )) as Response;
    expect(r.status).toBe(302);
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-dash_oauth=");
    expect(cookie).not.toContain("evil.example");
  });

  it("renders the domain form and preserves return_to when there is no shop", async () => {
    const r = await loader(
      req(
        "https://app.calderyncompany.com/dashboard/login?return_to=%2Fdashboard%2Fconnect%3Ft%3Dabc",
      ) as never,
    );
    // No shop chosen yet → the domain form renders; the state cookie is set
    // only once we redirect to a specific shop's authorize endpoint. The
    // connector destination is carried on the form (hidden field) meanwhile.
    const data = r as { mode: string; returnTo: string | null };
    expect(data.mode).toBe("form");
    expect(data.returnTo).toBe("/dashboard/connect?t=abc");
  });

  it("pins the state cookie to the chosen shop with no return_to field when none is given", async () => {
    const r = (await loader(
      req("https://app.calderyncompany.com/dashboard/login?shop=myshop.myshopify.com") as never,
    )) as Response;
    expect(r.status).toBe(302);
    const cookie = r.headers.get("set-cookie") ?? "";
    const value = decodeURIComponent(cookie.match(/__Host-dash_oauth=([^;]+)/)![1]);
    expect(value.endsWith(":myshop.myshopify.com")).toBe(true);
    expect(value.split(":")).toHaveLength(2);
  });
});
