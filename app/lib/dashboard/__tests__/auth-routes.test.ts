import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type * as SessionMod from "../session.server";
import type * as ShopifyOauthMod from "../shopify-oauth.server";

import { loader as loginLoader } from "../../../routes/dashboard.login";
import { loader as callbackLoader } from "../../../routes/dashboard.auth.callback";

const {
  createSession,
  resolveShopId,
  exchangeCodeForToken,
  latestImport,
  startImport,
  kickDrainSoon,
  storeSession,
  completeShopInstall,
} = vi.hoisted(() => ({
  createSession: vi.fn(async () => ({ raw: "dash_live_token" })),
  resolveShopId: vi.fn(async () => "shop-1"),
  exchangeCodeForToken: vi.fn(async () => ({
    accessToken: "tok-1",
    scope: "read_products",
    expiresIn: 86_399,
    refreshToken: "rt-1",
    refreshTokenExpiresIn: 7_775_999,
  })),
  latestImport: vi.fn(async (_shopId: string) => null as unknown),
  startImport: vi.fn(async () => ({ importId: "run-1" })),
  kickDrainSoon: vi.fn(async () => undefined),
  storeSession: vi.fn(async () => true),
  completeShopInstall: vi.fn(async () => undefined),
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
vi.mock("~/lib/import/run.server", () => ({
  latestImport,
  startImport,
  kickDrainSoon,
}));
vi.mock("~/shopify.server", () => ({
  sessionStorage: { storeSession },
  unauthenticated: { admin: vi.fn(async () => ({ admin: {} })) },
}));
vi.mock("~/lib/install.server", () => ({
  completeShopInstall,
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

afterEach(() => {
  vi.unstubAllGlobals();
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
  it("422s on an invalid shop with friendly error-page data", async () => {
    const res = (await loginLoader({
      request: new Request("https://calderyncompany.com/dashboard/login?shop=evil.com"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.mode).toBe("error");
    expect(body.errorCode).toBe("invalid_shop");
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

  it("renders the store-domain form (no redirect) when no shop is known", async () => {
    // Shopify's authorization code grant is per-shop — there is no shop-less
    // authorize endpoint — so the store domain must be collected before we can
    // build a working authorize URL.
    const res = await loginLoader({
      request: new Request("https://calderyncompany.com/dashboard/login"),
      params: {},
      context: {},
    });
    expect((res as { mode: string }).mode).toBe("form");
  });

  it("prefills the domain form from the remembered-shop hint", async () => {
    const res = await loginLoader({
      request: new Request("https://calderyncompany.com/dashboard/login", {
        headers: { Cookie: "__Host-dash_shop=remembered.myshopify.com" },
      }),
      params: {},
      context: {},
    });
    const data = res as { mode: string; hintShop: string | null };
    expect(data.mode).toBe("form");
    expect(data.hintShop).toBe("remembered.myshopify.com");
  });

  it("bounces OAuth init (with shop) to the canonical public host when begun on another origin", async () => {
    // The __Host- state cookie is locked to the initiating host; the callback
    // always lands on the canonical host (DASHBOARD_PUBLIC_URL). A ?shop= flow
    // begun on the app origin must be routed to the canonical host BEFORE the
    // cookie is minted, or the callback finds no state and fails oauth_failed.
    const res = (await loginLoader({
      request: new Request("https://app.calderyncompany.com/dashboard/login?shop=x.myshopify.com"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://calderyncompany.com/dashboard/login");
    expect(loc.searchParams.get("shop")).toBe("x.myshopify.com");
    expect(loc.searchParams.get("_oh")).toBe("1");
    // No cookie here — it must be set on the canonical host, not the app origin.
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("bounces the domain-form step to the canonical host too (no shop yet)", async () => {
    // The form must render on the canonical host so its submit (and the cookie
    // that submit triggers) also lands there.
    const res = (await loginLoader({
      request: new Request("https://app.calderyncompany.com/dashboard/login"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://calderyncompany.com/dashboard/login?_oh=1");
  });

  it("carries return_to through the canonical-host bounce", async () => {
    const res = (await loginLoader({
      request: new Request(
        "https://app.calderyncompany.com/dashboard/login?shop=x.myshopify.com&return_to=%2Fdashboard%2Fconnect%3Ft%3Dabc",
      ),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.searchParams.get("return_to")).toBe("/dashboard/connect?t=abc");
    expect(loc.searchParams.get("_oh")).toBe("1");
  });

  it("mints the state cookie and enters Shopify OAuth once the host marker is present", async () => {
    // Second pass: the browser is now on the canonical host (marker set), so the
    // cookie is minted here and the redirect_uri matches the callback host.
    const res = (await loginLoader({
      request: new Request(
        "https://app.calderyncompany.com/dashboard/login?shop=x.myshopify.com&_oh=1",
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
    expect(res.headers.get("Set-Cookie")).toContain("__Host-dash_oauth=");
  });

  it("does not auto-redirect (loop) when bounced back with an error", async () => {
    const res = (await loginLoader({
      request: new Request(
        "https://calderyncompany.com/dashboard/login?error=oauth_failed",
        { headers: { Cookie: "__Host-dash_shop=remembered.myshopify.com" } },
      ),
      params: {},
      context: {},
    })) as { mode: string; errorCode: string | null };
    // Returns error-mode page data — never a redirect (which would loop).
    expect(res.mode).toBe("error");
    expect(res.errorCode).toBe("oauth_failed");
  });

  it("still 422s when an explicit ?shop is malformed", async () => {
    const res = (await loginLoader({
      request: new Request("https://calderyncompany.com/dashboard/login?shop=evil.com"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.mode).toBe("error");
    expect(body.errorCode).toBe("invalid_shop");
  });
});

describe("dashboard.auth.callback loader", () => {
  function callbackRequest(url: string, stateCookie: string) {
    return new Request(url, { headers: { Cookie: `__Host-dash_oauth=${stateCookie}` } });
  }

  it("sets the session cookie and redirects to /dashboard on success", async () => {
    latestImport.mockResolvedValueOnce({ state: "done" });
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

  it("persists the exchanged offline token (with expiry + refresh token) via the library store", async () => {
    latestImport.mockResolvedValueOnce({ state: "done" });
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
    expect(storeSession).toHaveBeenCalledOnce();
    const session = (storeSession.mock.calls[0] as unknown[])[0] as {
      id: string;
      shop: string;
      accessToken: string;
      isOnline: boolean;
      scope: string;
      expires: Date | undefined;
      refreshToken: string | undefined;
    };
    expect(session.id).toBe("offline_x.myshopify.com");
    expect(session.shop).toBe("x.myshopify.com");
    expect(session.accessToken).toBe("tok-1");
    expect(session.isOnline).toBe(false);
    expect(session.scope).toBe("read_products");
    // expiringOfflineAccessTokens is on: the row must carry the real expiry
    // and refresh token or the library treats the session as unrefreshable.
    expect(session.expires).toBeInstanceOf(Date);
    expect(session.refreshToken).toBe("rt-1");
  });

  it("fails the round-trip when Shopify rejects the code exchange", async () => {
    exchangeCodeForToken.mockResolvedValueOnce(null as never);
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
    expect(res.headers.get("Location")).toContain("error=oauth_failed");
    expect(storeSession).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("accepts a shop-less (*) state cookie and binds the shop from the signed params", async () => {
    latestImport.mockResolvedValueOnce({ state: "done" });
    const url = signedCallbackUrl({
      shop: "x.myshopify.com",
      code: "code-1",
      state: "nonce-1",
      timestamp: "1",
    });
    const res = (await callbackLoader({
      request: callbackRequest(url, "nonce-1:*"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).not.toContain("error=");
    expect(createSession).toHaveBeenCalledWith("x.myshopify.com");
  });

  it("still rejects a pinned state cookie whose shop differs from the callback shop", async () => {
    const url = signedCallbackUrl({
      shop: "x.myshopify.com",
      code: "code-1",
      state: "nonce-1",
      timestamp: "1",
    });
    const res = (await callbackLoader({
      request: callbackRequest(url, "nonce-1:other.myshopify.com"),
      params: {},
      context: {},
    })) as Response;
    expect(res.headers.get("Location")).toContain("error=oauth_failed");
    expect(createSession).not.toHaveBeenCalled();
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

  it("does not crash on a malformed return_to encoding — steers to the native store instead", async () => {
    const url = signedCallbackUrl({
      shop: "x.myshopify.com",
      code: "code-1",
      state: "nonce-1",
      timestamp: "1",
    });
    // A trailing '%' is not a valid percent-encoding; decodeURIComponent throws
    // and the consumer must swallow it rather than 500 the OAuth round-trip.
    // With no valid return_to, port steering kicks in (latestImport → null →
    // no completed import → auto-port + /dashboard/store).
    const res = (await callbackLoader({
      request: callbackRequest(url, "nonce-1:x.myshopify.com:bad%"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://calderyncompany.com/dashboard/store");
  });

  it("runs the shared install routine on every connect — approve IS the install", async () => {
    latestImport.mockResolvedValueOnce({ state: "done" });
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
    expect(res.headers.get("Location")).not.toContain("error=");
    // Always — a returning soft-uninstalled shop needs uninstalled_at cleared
    // (provisionShop inside the routine), and a dashboard-first shop needs the
    // ingest enqueue + carrier service the embedded afterAuth would have done.
    expect(completeShopInstall).toHaveBeenCalledWith(
      expect.objectContaining({ shop: "x.myshopify.com", inlineBackfill: false }),
    );
    expect(createSession).toHaveBeenCalledWith("x.myshopify.com");
  });

  it("an install-extras failure does not block sign-in when the tenant resolves", async () => {
    latestImport.mockResolvedValueOnce({ state: "done" });
    completeShopInstall.mockRejectedValueOnce(new Error("carrier registration exploded"));
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
    expect(res.headers.get("Location")).not.toContain("error=");
    expect(createSession).toHaveBeenCalledWith("x.myshopify.com");
  });

  it("falls back to the friendly error page when the tenant cannot be provisioned", async () => {
    completeShopInstall.mockRejectedValueOnce(new Error("supabase down"));
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
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/dashboard/login?error=app_not_installed");
    const setCookie = res.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("__Host-dash_oauth=");
    expect(setCookie).toContain("Max-Age=0");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("auto-starts the data port and lands on the native store when no import completed", async () => {
    // latestImport returns null (default mock) — shop has never ported.
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
    // The merchant never clicks an "Import" button — approve starts the port,
    // and the drain is nudged so the pull begins before the next cron tick.
    expect(startImport).toHaveBeenCalledWith("shop-1");
    expect(kickDrainSoon).toHaveBeenCalled();
    expect(res.headers.get("Location")).toBe("https://calderyncompany.com/dashboard/store");
  });

  it("does not re-queue the port for a shop whose last import errored — steers to the import screen", async () => {
    // A deterministically-failing import must not re-trigger a 12-month pull
    // on every sign-in; the import screen owns the error + manual retry.
    latestImport.mockResolvedValueOnce({ state: "error" });
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
    expect(startImport).not.toHaveBeenCalled();
    expect(res.headers.get("Location")).toBe(
      "https://calderyncompany.com/dashboard/settings/import",
    );
  });

  it("does not double-start an in-progress port and still lands on the native store", async () => {
    latestImport.mockResolvedValueOnce({ state: "pulling" });
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
    expect(startImport).not.toHaveBeenCalled();
    expect(res.headers.get("Location")).toBe("https://calderyncompany.com/dashboard/store");
  });

  it("sends a shop whose import is done to the dashboard home without restarting the port", async () => {
    latestImport.mockResolvedValueOnce({ state: "done" });
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
    const loc = res.headers.get("Location")!;
    expect(loc).toContain("/dashboard");
    expect(loc).not.toContain("/dashboard/store");
    expect(startImport).not.toHaveBeenCalled();
  });

  it("lets an explicit return_to win over import steering", async () => {
    // latestImport is null (default) but return_to takes priority
    const url = signedCallbackUrl({
      shop: "x.myshopify.com",
      code: "code-1",
      state: "nonce-1",
      timestamp: "1",
    });
    const returnTo = encodeURIComponent("/dashboard/connect?t=abc");
    const res = (await callbackLoader({
      request: callbackRequest(url, `nonce-1:x.myshopify.com:${returnTo}`),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/dashboard/connect?t=abc");
  });

  it("lands on the import screen (manual retry) when the auto-port itself fails", async () => {
    // A swallowed startImport failure must not strand the merchant on an
    // empty home with no queued run and no signal — the import screen has
    // the honest state + a retry button.
    latestImport.mockRejectedValueOnce(new Error("poll failed"));
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
    expect(res.headers.get("Location")).toBe(
      "https://calderyncompany.com/dashboard/settings/import",
    );
  });
});
