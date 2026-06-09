import { describe, it, expect, beforeEach } from "vitest";
import { pkceChallenge, verifyPkce, newClientId, newAuthCode, newAccessToken, newRefreshToken, sha256hex, signPendingOauth, verifyPendingOauth } from "../mcp_oauth.server";

describe("pkceChallenge (S256)", () => {
  it("produces a 43-char base64url challenge from a 43-128 char verifier", () => {
    // RFC 7636 §4.6 reference vector
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = pkceChallenge(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("verifyPkce", () => {
  it("returns true when verifier matches challenge", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it("returns false when verifier does not match challenge", () => {
    expect(verifyPkce("wrong-verifier", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(false);
  });

  it("returns false for too-short verifier (< 43 chars)", () => {
    expect(verifyPkce("short", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(false);
  });
});

describe("id generators", () => {
  it("newClientId has 'cal_client_' prefix and 16 base32 body", () => {
    const id = newClientId();
    expect(id).toMatch(/^cal_client_[a-z2-7]{16}$/);
  });

  it("newAuthCode has 'calc_' prefix and 32 base32 body", () => {
    const c = newAuthCode();
    expect(c).toMatch(/^calc_[a-z2-7]{32}$/);
  });

  it("newAccessToken has 'cala_' prefix and 32 base32 body", () => {
    const t = newAccessToken();
    expect(t).toMatch(/^cala_[a-z2-7]{32}$/);
  });

  it("newRefreshToken has 'calr_' prefix and 32 base32 body", () => {
    const t = newRefreshToken();
    expect(t).toMatch(/^calr_[a-z2-7]{32}$/);
  });

  it("generators produce unique values", () => {
    const xs = new Set<string>();
    for (let i = 0; i < 1000; i++) xs.add(newAccessToken());
    expect(xs.size).toBe(1000);
  });
});

describe("sha256hex", () => {
  it("matches a known vector", () => {
    expect(sha256hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

const _ctx = {
  client_id: "cal_client_x",
  redirect_uri: "https://claude.ai/cb",
  code_challenge: "ch",
  scope: "read",
  state: "abc",
  shop: "myshop.myshopify.com",
};

describe("pending OAuth cookie", () => {
  beforeEach(() => {
    process.env.MCP_OAUTH_COOKIE_SECRET = "a".repeat(64);
  });

  it("round-trips a signed payload", async () => {
    const jwt = await signPendingOauth(_ctx);
    expect(typeof jwt).toBe("string");
    const decoded = await verifyPendingOauth(jwt);
    expect(decoded).toMatchObject(_ctx);
  });

  it("rejects a tampered payload", async () => {
    const jwt = await signPendingOauth(_ctx);
    const tampered = jwt.slice(0, -1) + (jwt.endsWith("a") ? "b" : "a");
    await expect(verifyPendingOauth(tampered)).rejects.toThrow();
  });

  it("rejects an expired payload", async () => {
    const jwt = await signPendingOauth(_ctx, { ttlSec: 1 });
    await new Promise((r) => setTimeout(r, 1200));
    await expect(verifyPendingOauth(jwt)).rejects.toThrow();
  });
});
