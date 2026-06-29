import { describe, it, expect } from "vitest";
import { buildSigninAuthUrl, exchangeCodeForIdToken, verifyIdToken } from "../google-signin.server";

describe("google sign-in oauth", () => {
  it("builds an auth url with the openid email profile scope", () => {
    const url = buildSigninAuthUrl({ clientId: "cid", redirectUri: "https://app.x/cb", state: "st" });
    expect(url).toContain("scope=openid+email+profile");
    expect(url).toContain("response_type=code");
    expect(url).toContain("state=st");
  });

  it("exchangeCodeForIdToken returns the id_token", async () => {
    const fetcher = async () => ({ id_token: "ID", access_token: "AC" });
    expect(await exchangeCodeForIdToken(fetcher, { clientId: "c", clientSecret: "s", redirectUri: "r", code: "x" })).toBe("ID");
  });

  it("verifyIdToken accepts a valid token and rejects a wrong aud / unverified email", async () => {
    const good = async () => ({ aud: "cid", iss: "https://accounts.google.com", sub: "g1", email: "a@b.co", email_verified: "true", exp: String(Math.floor(Date.now()/1000)+600) });
    expect(await verifyIdToken(good, "tok", "cid")).toEqual({ sub: "g1", email: "a@b.co", emailVerified: true });
    const wrongAud = async () => ({ aud: "other", iss: "https://accounts.google.com", sub: "g1", email: "a@b.co", email_verified: "true", exp: String(Math.floor(Date.now()/1000)+600) });
    await expect(verifyIdToken(wrongAud, "tok", "cid")).rejects.toThrow();
  });

  it("verifyIdToken returns emailVerified false for an unverified google email", async () => {
    const unverified = async () => ({ aud: "cid", iss: "https://accounts.google.com", sub: "g1", email: "a@b.co", email_verified: "false", exp: String(Math.floor(Date.now()/1000)+600) });
    expect(await verifyIdToken(unverified, "tok", "cid")).toEqual({ sub: "g1", email: "a@b.co", emailVerified: false });
  });
});
