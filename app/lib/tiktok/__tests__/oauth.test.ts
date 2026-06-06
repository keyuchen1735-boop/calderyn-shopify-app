import { describe, it, expect, vi } from "vitest";
import { buildAuthUrl, exchangeCodeForToken } from "../oauth.server";

describe("buildAuthUrl", () => {
  it("targets the TikTok portal auth endpoint with app_id, redirect_uri, state", () => {
    const url = buildAuthUrl({
      appId: "app-1",
      redirectUri: "https://x/auth/tiktok",
      state: "st",
    });
    expect(url).toContain("https://business-api.tiktok.com/portal/auth?");
    expect(url).toContain("app_id=app-1");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fx%2Fauth%2Ftiktok");
    expect(url).toContain("state=st");
  });
});

describe("exchangeCodeForToken", () => {
  it("POSTs JSON and parses the data envelope on success (code 0)", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({
      code: 0,
      message: "OK",
      data: {
        access_token: "tok",
        refresh_token: "refresh",
        advertiser_ids: ["adv-1", "adv-2"],
        expires_in: 86400,
      },
    });
    const res = await exchangeCodeForToken(fetcher, {
      appId: "app-1",
      appSecret: "secret",
      code: "auth-code",
    });
    expect(res).toEqual({ accessToken: "tok", advertiserId: "adv-1", expiresInSec: 86400 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      app_id: "app-1",
      secret: "secret",
      auth_code: "auth-code",
      grant_type: "authorization_code",
    });
  });

  it("returns a null advertiserId when none are present", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, data: { access_token: "tok", expires_in: 0 } });
    const res = await exchangeCodeForToken(fetcher, {
      appId: "a",
      appSecret: "s",
      code: "c",
    });
    expect(res.advertiserId).toBeNull();
    expect(res.accessToken).toBe("tok");
  });

  it("throws on a non-zero response code carrying a message", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ code: 40002, message: "invalid auth_code" });
    await expect(
      exchangeCodeForToken(fetcher, { appId: "a", appSecret: "s", code: "x" }),
    ).rejects.toThrow(/invalid auth_code/);
  });

  it("throws when success body lacks an access_token", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ code: 0, data: {} });
    await expect(
      exchangeCodeForToken(fetcher, { appId: "a", appSecret: "s", code: "x" }),
    ).rejects.toThrow(/no access_token/);
  });
});
