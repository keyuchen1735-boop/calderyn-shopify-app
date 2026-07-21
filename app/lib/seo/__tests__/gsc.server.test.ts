import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildGscAuthUrl,
  exchangeGscCode,
  gscRedirectUri,
  refreshGscAccessToken,
  saveGscCredential,
  loadGscRefreshToken,
  disconnectGsc,
} from "../gsc.server";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));
vi.mock("~/lib/crypto.server", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
}));

// The module reads Google client env at call time; snapshot and restore so
// per-test mutations never leak into other suites in the same worker.
const ENV_KEYS = [
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_SEARCH_CONSOLE_CLIENT_ID",
  "GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET",
  "DASHBOARD_PUBLIC_URL",
  "SHOPIFY_APP_URL",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.GOOGLE_ADS_CLIENT_ID = "test-client";
  process.env.GOOGLE_ADS_CLIENT_SECRET = "test-secret";
  delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID;
  delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prior = savedEnv[key];
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
});

describe("buildGscAuthUrl", () => {
  it("requests offline webmasters.readonly consent", () => {
    process.env.GOOGLE_ADS_CLIENT_ID = "ads-client";
    delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID;
    const url = new URL(buildGscAuthUrl({ redirectUri: "https://app.example/cb", state: "st1" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("ads-client");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/webmasters.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("st1");
    // Never widen the credential beyond webmasters.readonly: granting
    // include_granted_scopes would fold prior adwords consent into this token.
    expect(url.searchParams.get("include_granted_scopes")).toBeNull();
  });
  it("prefers the dedicated GSC client id", () => {
    process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID = "gsc-client";
    const url = new URL(buildGscAuthUrl({ redirectUri: "https://app.example/cb", state: "s" }));
    expect(url.searchParams.get("client_id")).toBe("gsc-client");
  });
});

describe("gscRedirectUri", () => {
  it("pins the callback to the public base URL, not the request host", () => {
    process.env.DASHBOARD_PUBLIC_URL = "https://app.calderyncompany.com";
    expect(gscRedirectUri()).toBe("https://app.calderyncompany.com/dashboard/auth/gsc/callback");
  });
  it("falls back to SHOPIFY_APP_URL when DASHBOARD_PUBLIC_URL is unset", () => {
    delete process.env.DASHBOARD_PUBLIC_URL;
    process.env.SHOPIFY_APP_URL = "https://fallback.example";
    expect(gscRedirectUri()).toBe("https://fallback.example/dashboard/auth/gsc/callback");
  });
});

describe("exchangeGscCode / refreshGscAccessToken", () => {
  it("exchanges the code and surfaces the Google error body on failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ refresh_token: "rt", access_token: "at" }), { status: 200 }),
    );
    const out = await exchangeGscCode("code1", "https://app.example/cb", fetcher as typeof fetch);
    expect(out).toEqual({ refreshToken: "rt", accessToken: "at" });
    const failing = vi.fn().mockResolvedValue(new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expect(exchangeGscCode("bad", "https://app.example/cb", failing as typeof fetch))
      .rejects.toThrow(/invalid_grant/);
  });
  it("refreshes an access token", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "fresh" }), { status: 200 }),
    );
    await expect(refreshGscAccessToken("rt", fetcher as typeof fetch)).resolves.toBe("fresh");
  });
});

describe("credential store", () => {
  it("saves encrypted and loads decrypted", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const maybeSingle = vi.fn().mockResolvedValue({ data: { refresh_token_encrypted: "enc:rt" }, error: null });
    fromMock.mockImplementation((table: string) => {
      if (table !== "seo_google_credential") throw new Error(`unexpected table ${table}`);
      return {
        upsert,
        select: () => ({ eq: () => ({ maybeSingle }) }),
      };
    });
    await saveGscCredential("shop-1", "rt");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ shop_id: "shop-1", refresh_token_encrypted: "enc:rt" }),
      { onConflict: "shop_id" },
    );
    await expect(loadGscRefreshToken("shop-1")).resolves.toBe("rt");
  });
});

describe("disconnectGsc", () => {
  function mockTables(opts: { hasToken: boolean }) {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: opts.hasToken ? { refresh_token_encrypted: "enc:rt" } : null,
      error: null,
    });
    const del = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockImplementation((table: string) => {
      if (table === "seo_google_credential") {
        return {
          select: () => ({ eq: () => ({ maybeSingle }) }),
          delete: () => ({ eq: del }),
        };
      }
      if (table === "seo_settings") {
        return { update: () => ({ eq: update }) };
      }
      throw new Error(`unexpected table ${table}`);
    });
    return { del, update };
  }

  it("revokes with Google using the stored token, then deletes and clears settings", async () => {
    const { del, update } = mockTables({ hasToken: true });
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await disconnectGsc("shop-1", fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe("token=rt");
    expect(del).toHaveBeenCalledWith("shop_id", "shop-1");
    expect(update).toHaveBeenCalledWith("shop_id", "shop-1");
  });

  it("still deletes and clears settings when revoke fails", async () => {
    const { del, update } = mockTables({ hasToken: true });
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(disconnectGsc("shop-1", fetcher as typeof fetch)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith("shop_id", "shop-1");
    expect(update).toHaveBeenCalledWith("shop_id", "shop-1");
  });

  it("skips revoke when no token is stored", async () => {
    const { del, update } = mockTables({ hasToken: false });
    const fetcher = vi.fn();
    await disconnectGsc("shop-1", fetcher as typeof fetch);
    expect(fetcher).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith("shop_id", "shop-1");
    expect(update).toHaveBeenCalledWith("shop_id", "shop-1");
  });
});
