import { describe, it, expect, vi } from "vitest";
import { buildAuthUrl, exchangeCodeForToken, googleConnectErrorReason } from "../oauth.server";

describe("googleConnectErrorReason", () => {
  it("gives an actionable message when the authorizing account has no Ads account (NOT_ADS_USER)", () => {
    // The exact authenticationError Google returns when a merchant authorizes
    // with a Google account that isn't linked to any Google Ads account.
    const raw = JSON.stringify({
      error: {
        status: "UNAUTHENTICATED",
        details: [{ errors: [{ errorCode: { authenticationError: "NOT_ADS_USER" } }] }],
      },
    });
    const msg = googleConnectErrorReason(raw);
    expect(msg).toMatch(/Google Ads account/i);
    expect(msg).toMatch(/reconnect|choose|account that manages/i);
  });

  it("gives a safe generic message for any other lookup failure", () => {
    const msg = googleConnectErrorReason(JSON.stringify({ error: { code: 500 } }));
    expect(msg).not.toContain("NOT_ADS_USER");
    expect(msg).toMatch(/reconnect|try again/i);
  });
});

describe("buildAuthUrl", () => {
  it("targets the Google auth endpoint with offline access and the adwords scope", () => {
    const url = buildAuthUrl({
      clientId: "cid",
      redirectUri: "https://x/auth/google",
      state: "st",
    });
    expect(url).toContain("https://accounts.google.com/o/oauth2/v2/auth?");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fx%2Fauth%2Fgoogle");
    expect(url).toContain("response_type=code");
    expect(url).toContain("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fadwords");
    expect(url).toContain("state=st");
    expect(url).toContain("access_type=offline");
    expect(url).toContain("prompt=consent");
  });

  it("requests only the adwords scope (least privilege)", () => {
    const url = new URL(
      buildAuthUrl({ clientId: "c", redirectUri: "https://x/auth/google", state: "s" }),
    );
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adwords");
  });
});

describe("exchangeCodeForToken", () => {
  it("POSTs an authorization_code grant and returns the refresh token", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3599,
      token_type: "Bearer",
    });
    const res = await exchangeCodeForToken(fetcher, {
      clientId: "cid",
      clientSecret: "secret",
      redirectUri: "https://x/auth/google",
      code: "abc",
    });
    expect(res).toEqual({ refreshToken: "rt", accessToken: "at", expiresInSec: 3599 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect(init.body).toContain("grant_type=authorization_code");
    expect(init.body).toContain("code=abc");
    expect(init.body).toContain("client_id=cid");
    expect(init.body).toContain("client_secret=secret");
  });

  it("throws on an OAuth error body", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ error: "invalid_grant", error_description: "bad code" });
    await expect(
      exchangeCodeForToken(fetcher, {
        clientId: "c",
        clientSecret: "s",
        redirectUri: "r",
        code: "x",
      }),
    ).rejects.toThrow(/bad code/);
  });

  it("throws when Google omits the refresh_token (silent re-consent)", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ access_token: "at", expires_in: 3599 });
    await expect(
      exchangeCodeForToken(fetcher, {
        clientId: "c",
        clientSecret: "s",
        redirectUri: "r",
        code: "x",
      }),
    ).rejects.toThrow(/no refresh_token/);
  });
});
