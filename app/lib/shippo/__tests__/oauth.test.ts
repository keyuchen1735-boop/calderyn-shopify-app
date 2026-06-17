import { describe, it, expect, vi } from "vitest";
import { buildAuthUrl, exchangeCodeForToken } from "../oauth.server";

describe("buildAuthUrl", () => {
  it("targets goshippo.com/oauth/authorize with response_type, client_id, scope, state, redirect_uri", () => {
    const url = buildAuthUrl({ clientId: "cid", redirectUri: "https://x/auth/shippo", state: "st" });
    expect(url).toContain("https://goshippo.com/oauth/authorize?");
    expect(url).toContain("response_type=code");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("scope=*"); // URLSearchParams leaves "*" literal (unreserved); Shippo wants the wildcard scope.
    expect(url).toContain("state=st");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fx%2Fauth%2Fshippo");
  });
});

describe("exchangeCodeForToken", () => {
  it("posts the authorization_code grant with client creds + redirect_uri in the form body", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      access_token: "oauth.tok", token_type: "bearer", scope: "*", account_id: "acct-9",
    });
    const res = await exchangeCodeForToken(fetcher, {
      clientId: "cid", clientSecret: "sec", redirectUri: "https://x/auth/shippo", code: "abc",
    });
    expect(res).toEqual({ accessToken: "oauth.tok", scope: "*", accountId: "acct-9" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.goshippo.com/oauth/access_token");
    expect(init.body).toContain("grant_type=authorization_code");
    expect(init.body).toContain("code=abc");
    expect(init.body).toContain("client_id=cid");
    expect(init.body).toContain("client_secret=sec");
    expect(init.body).toContain("redirect_uri=https%3A%2F%2Fx%2Fauth%2Fshippo");
  });

  it("defaults accountId to null and scope to '*' when the response omits them", async () => {
    const fetcher = vi.fn().mockResolvedValue({ access_token: "oauth.tok", token_type: "bearer" });
    const res = await exchangeCodeForToken(fetcher, {
      clientId: "c", clientSecret: "s", redirectUri: "r", code: "x",
    });
    expect(res).toEqual({ accessToken: "oauth.tok", scope: "*", accountId: null });
  });

  it("falls back to the `owner` field for accountId when account_id is absent", async () => {
    const fetcher = vi.fn().mockResolvedValue({ access_token: "oauth.tok", owner: "owner-7" });
    const res = await exchangeCodeForToken(fetcher, {
      clientId: "c", clientSecret: "s", redirectUri: "r", code: "x",
    });
    expect(res.accountId).toBe("owner-7");
  });

  it("throws on an OAuth error (no access_token)", async () => {
    const fetcher = vi.fn().mockResolvedValue({ error: "invalid_grant", error_description: "bad code" });
    await expect(
      exchangeCodeForToken(fetcher, { clientId: "c", clientSecret: "s", redirectUri: "r", code: "x" }),
    ).rejects.toThrow(/bad code/);
  });
});
