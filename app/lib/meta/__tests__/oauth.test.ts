import { describe, it, expect, vi } from "vitest";
import { buildAuthUrl, signState, verifyState, exchangeCodeForToken } from "../oauth.server";

const SECRET = "app-secret";

describe("buildAuthUrl", () => {
  it("includes client_id, redirect_uri, scope, and state", () => {
    const url = buildAuthUrl({ appId: "111", redirectUri: "https://x/auth/meta", state: "st" });
    expect(url).toContain("https://www.facebook.com/v21.0/dialog/oauth?");
    expect(url).toContain("client_id=111");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fx%2Fauth%2Fmeta");
    expect(url).toContain("scope=ads_management%2Cads_read");
    expect(url).toContain("state=st");
  });
});

describe("state sign/verify", () => {
  it("round-trips the shop and rejects tampering", () => {
    const st = signState("acme.myshopify.com", SECRET);
    expect(verifyState(st, SECRET)).toBe("acme.myshopify.com");
    expect(verifyState(st + "x", SECRET)).toBeNull();
    expect(verifyState(st, "wrong-secret")).toBeNull();
  });
});

describe("exchangeCodeForToken", () => {
  it("exchanges code then upgrades to a long-lived token", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ access_token: "short", expires_in: 3600 })
      .mockResolvedValueOnce({ access_token: "long", expires_in: 5184000 });
    const res = await exchangeCodeForToken(fetcher, {
      appId: "111",
      appSecret: SECRET,
      redirectUri: "https://x/auth/meta",
      code: "abc",
    });
    expect(res).toEqual({ accessToken: "long", expiresInSec: 5184000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toContain("/oauth/access_token?");
    expect(fetcher.mock.calls[0][0]).toContain("code=abc");
    expect(fetcher.mock.calls[1][0]).toContain("grant_type=fb_exchange_token");
    expect(fetcher.mock.calls[1][0]).toContain("fb_exchange_token=short");
  });

  it("throws on a Graph error during exchange", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ error: { message: "bad code", code: 100 } });
    await expect(
      exchangeCodeForToken(fetcher, { appId: "1", appSecret: SECRET, redirectUri: "r", code: "x" }),
    ).rejects.toThrow(/bad code/);
  });
});
