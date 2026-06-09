import { describe, it, expect } from "vitest";
import { pkceChallenge, verifyPkce } from "../mcp_oauth.server";

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
