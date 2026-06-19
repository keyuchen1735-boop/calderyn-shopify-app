import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import type * as SessionMod from "../session.server";
import type * as ShopifyOauthMod from "../shopify-oauth.server";

import { loader as loginLoader } from "../../../routes/dashboard.login";
import { loader as callbackLoader } from "../../../routes/dashboard.auth.callback";

const { createSession, resolveShopId, exchangeCodeForToken } = vi.hoisted(() => ({
  createSession: vi.fn(async () => ({ raw: "dash_live_token" })),
  resolveShopId: vi.fn(async () => "shop-1"),
  exchangeCodeForToken: vi.fn(async () => true),
}));

vi.mock("../session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionMod>()),
  createSession,
}));
vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({}),
  resolveShopId,
}));
vi.mock("../shopify-oauth.server", async (importOriginal) => ({
  ...(await importOriginal<typeof ShopifyOauthMod>()),
  exchangeCodeForToken,
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_API_KEY = "client-1";
  process.env.SHOPIFY_API_SECRET = "secret-1";
  process.env.SCOPES = "read_products";
  process.env.DASHBOARD_PUBLIC_URL = "https://calderyncompany.com";
  process.env.SHOPIFY_APP_URL = "https://app.calderyncompany.com";
  process.env.DASHBOARD_SESSION_PEPPER = "test-pepper-that-is-at-least-32-chars!!";
});

function signedCallbackUrl(params: Record<string, string>): string {
  const sp = new URLSearchParams(params);
  const message = [...sp.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  sp.set("hmac", createHmac("sha256", "secret-1").update(message).digest("hex"));
  return `https://calderyncompany.com/dashboard/auth/callback?${sp.toString()}`;
}

describe("dashboard.login loader", () => {
  it("422s on an invalid shop", async () => {
    const res = (await loginLoader({
      request: new Request("https://calderyncompany.com/dashboard/login?shop=evil.com"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(422);
  });

  it("redirects to the shop's authorize URL and sets a state cookie", async () => {
    const res = (await loginLoader({
      request: new Request(
        "https://calderyncompany.com/dashboard/login?shop=x.myshopify.com",
      ),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://x.myshopify.com/admin/oauth/authorize");
    expect(loc.searchParams.get("redirect_uri")).toBe(
      "https://calderyncompany.com/dashboard/auth/callback",
    );
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain("__Host-dash_oauth=");
    expect(cookie).toContain("HttpOnly");
    expect(loc.searchParams.get("state")).toBe(
      decodeURIComponent(cookie.match(/__Host-dash_oauth=([^;]+)/)![1]).split(":")[0],
    );
  });

  it("auto-redirects to Shopify using the remembered shop when no ?shop is given", async () => {
    const res = (await loginLoader({
      request: new Request("https://calderyncompany.com/dashboard/login", {
        headers: { Cookie: "__Host-dash_shop=remembered.myshopify.com" },
      }),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(
      "https://remembered.myshopify.com/admin/oauth/authorize",
    );
  });

  it("shows an HTML landing (not raw JSON) when no shop is known", async () => {
    const res = (await loginLoader({
      request: new Request("https://calderyncompany.com/dashboard/login"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).not.toContain("invalid_shop");
  });

  it("does not auto-redirect (loop) when bounced back with an error", async () => {
    const res = (await loginLoader({
      request: new Request(
        "https://calderyncompany.com/dashboard/login?error=oauth_failed",
        { headers: { Cookie: "__Host-dash_shop=remembered.myshopify.com" } },
      ),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("still 422s when an explicit ?shop is malformed", async () => {
    const res = (await loginLoader({
      request: new Request("https://calderyncompany.com/dashboard/login?shop=evil.com"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(422);
  });
});

describe("dashboard.auth.callback loader", () => {
  function callbackRequest(url: string, stateCookie: string) {
    return new Request(url, { headers: { Cookie: `__Host-dash_oauth=${stateCookie}` } });
  }

  it("sets the session cookie and redirects to /dashboard on success", async () => {
    const url = signedCallbackUrl({
      shop: "x.myshopify.com",
      code: "code-1",
      state: "nonce-1",
      timestamp: "1",
    });
    const res = (await callbackLoader({
      request: callbackRequest(url, "nonce-1:x.myshopify.com"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://calderyncompany.com/dashboard");
    expect(res.headers.get("Set-Cookie")).toContain("__Host-calderyn_dash=dash_live_token");
    expect(res.headers.get("Set-Cookie")).toContain("__Host-dash_shop=x.myshopify.com");
    expect(exchangeCodeForToken).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledWith("x.myshopify.com");
  });

  it("rejects a state mismatch", async () => {
    const url = signedCallbackUrl({
      shop: "x.myshopify.com",
      code: "code-1",
      state: "nonce-WRONG",
      timestamp: "1",
    });
    const res = (await callbackLoader({
      request: callbackRequest(url, "nonce-1:x.myshopify.com"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=oauth_failed");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects a bad HMAC", async () => {
    const url =
      "https://calderyncompany.com/dashboard/auth/callback?shop=x.myshopify.com&code=c&state=nonce-1&timestamp=1&hmac=deadbeef";
    const res = (await callbackLoader({
      request: callbackRequest(url, "nonce-1:x.myshopify.com"),
      params: {},
      context: {},
    })) as Response;
    expect(res.headers.get("Location")).toContain("error=oauth_failed");
  });

  it("honours a validated return_to carried in the state cookie", async () => {
    const url = signedCallbackUrl({
      shop: "x.myshopify.com",
      code: "code-1",
      state: "nonce-1",
      timestamp: "1",
    });
    const returnTo = encodeURIComponent("/dashboard/connect?t=abc.def.ghi");
    const res = (await callbackLoader({
      request: callbackRequest(url, `nonce-1:x.myshopify.com:${returnTo}`),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://calderyncompany.com/dashboard/connect?t=abc.def.ghi",
    );
  });

  it("falls back to /dashboard (no crash) on a malformed return_to encoding", async () => {
    const url = signedCallbackUrl({
      shop: "x.myshopify.com",
      code: "code-1",
      state: "nonce-1",
      timestamp: "1",
    });
    // A trailing '%' is not a valid percent-encoding; decodeURIComponent throws
    // and the consumer must swallow it rather than 500 the OAuth round-trip.
    const res = (await callbackLoader({
      request: callbackRequest(url, "nonce-1:x.myshopify.com:bad%"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://calderyncompany.com/dashboard");
  });

  it("403s app_not_installed when the shop is unknown", async () => {
    resolveShopId.mockRejectedValueOnce(new Error("Shop not found in Supabase: x"));
    const url = signedCallbackUrl({
      shop: "x.myshopify.com",
      code: "code-1",
      state: "nonce-1",
      timestamp: "1",
    });
    const res = (await callbackLoader({
      request: callbackRequest(url, "nonce-1:x.myshopify.com"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "app_not_installed" });
  });
});
