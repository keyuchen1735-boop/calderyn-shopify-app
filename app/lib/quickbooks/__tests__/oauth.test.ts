import { describe, it, expect, vi } from "vitest";
import {
  buildAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  isRevokedTokenError,
} from "../oauth.server";

describe("isRevokedTokenError", () => {
  it("is true for an invalid_grant error (merchant revoked / refresh token dead)", () => {
    expect(isRevokedTokenError(new Error("QuickBooks OAuth error: invalid_grant"))).toBe(true);
  });
  it("is false for other failures", () => {
    expect(isRevokedTokenError(new Error("QuickBooks API error: HTTP 500"))).toBe(false);
    expect(isRevokedTokenError("nope")).toBe(false);
    expect(isRevokedTokenError(null)).toBe(false);
  });
});

describe("buildAuthUrl", () => {
  it("includes client_id, redirect_uri, scope, state, response_type", () => {
    const url = buildAuthUrl({ clientId: "cid", redirectUri: "https://x/auth/quickbooks", state: "st" });
    expect(url).toContain("https://appcenter.intuit.com/connect/oauth2?");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fx%2Fauth%2Fquickbooks");
    expect(url).toContain("scope=com.intuit.quickbooks.accounting");
    expect(url).toContain("state=st");
    expect(url).toContain("response_type=code");
  });
});

describe("exchangeCodeForToken", () => {
  it("parses tokens and sends Basic auth + authorization_code grant", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      access_token: "acc", refresh_token: "ref", expires_in: 3600, x_refresh_token_expires_in: 8640000,
    });
    const res = await exchangeCodeForToken(fetcher, {
      clientId: "cid", clientSecret: "sec", redirectUri: "https://x/auth/quickbooks", code: "abc",
    });
    expect(res).toEqual({ accessToken: "acc", refreshToken: "ref", expiresInSec: 3600, refreshExpiresInSec: 8640000 });
    const [, init] = fetcher.mock.calls[0];
    expect(init.headers.Authorization).toBe("Basic " + Buffer.from("cid:sec").toString("base64"));
    expect(init.body).toContain("grant_type=authorization_code");
    expect(init.body).toContain("code=abc");
  });

  it("throws on an OAuth error", async () => {
    const fetcher = vi.fn().mockResolvedValue({ error: "invalid_grant", error_description: "bad code" });
    await expect(
      exchangeCodeForToken(fetcher, { clientId: "c", clientSecret: "s", redirectUri: "r", code: "x" }),
    ).rejects.toThrow(/bad code/);
  });
});

describe("refreshAccessToken", () => {
  it("returns the ROTATED refresh token and uses refresh_token grant", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      access_token: "acc2", refresh_token: "ref2", expires_in: 3600, x_refresh_token_expires_in: 8640000,
    });
    const res = await refreshAccessToken(fetcher, { clientId: "c", clientSecret: "s", refreshToken: "ref1" });
    expect(res.accessToken).toBe("acc2");
    expect(res.refreshToken).toBe("ref2");
    const [, init] = fetcher.mock.calls[0];
    expect(init.body).toContain("grant_type=refresh_token");
    expect(init.body).toContain("refresh_token=ref1");
  });
});
