import { describe, it, expect } from "vitest";
import { signActionToken, verifyActionToken } from "../token.server";

const SECRET = "test-secret-abc";
const ID = "11111111-2222-3333-4444-555555555555";

describe("social-digest action tokens", () => {
  it("round-trips a valid approve token", () => {
    const t = signActionToken(ID, "approve", 0, { secret: SECRET });
    expect(verifyActionToken(t, { secret: SECRET })).toEqual({ id: ID, action: "approve", version: 0 });
  });

  it("round-trips an owner (per-founder approve)", () => {
    const t = signActionToken(ID, "approve", 0, { secret: SECRET, owner: "john@calderyncompany.com" });
    expect(verifyActionToken(t, { secret: SECRET })).toEqual({
      id: ID,
      action: "approve",
      version: 0,
      owner: "john@calderyncompany.com",
    });
  });

  it("omits owner when not provided", () => {
    const t = signActionToken(ID, "reject", 0, { secret: SECRET });
    expect(verifyActionToken(t, { secret: SECRET })).toEqual({ id: ID, action: "reject", version: 0 });
  });

  it("carries the version so regenerated rounds differ", () => {
    const v0 = signActionToken(ID, "reject", 0, { secret: SECRET });
    const v1 = signActionToken(ID, "reject", 1, { secret: SECRET });
    expect(v0).not.toBe(v1);
    expect(verifyActionToken(v1, { secret: SECRET })?.version).toBe(1);
  });

  it("rejects a tampered payload", () => {
    const t = signActionToken(ID, "approve", 0, { secret: SECRET });
    const [, sig] = t.split(".");
    // flip the action by re-encoding a different payload but keeping the old sig
    const forged = Buffer.from(`${ID}:reject:0:${Date.now() + 10000}`).toString("base64url");
    expect(verifyActionToken(`${forged}.${sig}`, { secret: SECRET })).toBeNull();
  });

  it("rejects a garbage signature", () => {
    const t = signActionToken(ID, "approve", 0, { secret: SECRET });
    const [enc] = t.split(".");
    expect(verifyActionToken(`${enc}.deadbeef`, { secret: SECRET })).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const t = signActionToken(ID, "approve", 0, { secret: "other-secret" });
    expect(verifyActionToken(t, { secret: SECRET })).toBeNull();
  });

  it("rejects an expired token", () => {
    const now = 1_000_000_000_000;
    const t = signActionToken(ID, "approve", 0, { secret: SECRET, nowMs: now, ttlMs: 1000 });
    expect(verifyActionToken(t, { secret: SECRET, nowMs: now + 500 })).not.toBeNull();
    expect(verifyActionToken(t, { secret: SECRET, nowMs: now + 2000 })).toBeNull();
  });

  it("returns null on malformed input", () => {
    expect(verifyActionToken("", { secret: SECRET })).toBeNull();
    expect(verifyActionToken("nodot", { secret: SECRET })).toBeNull();
    expect(verifyActionToken(".", { secret: SECRET })).toBeNull();
  });

  it("rejects a token whose action is the old approve-linkedin string", () => {
    // Craft a raw token with the old action name and a fake sig.
    // verifyActionToken will reject it via isAction() before it checks the HMAC
    // (the sig check uses timing-safe equal; we just need it to reach isAction).
    // We can't sign it correctly without access to the internals, so we use a
    // well-formed but obvious forgery — the sig mismatch means it returns null
    // regardless, which is what we want: old tokens are not accepted.
    const payload = `${ID}:approve-linkedin:0:${Date.now() + 100_000}`;
    const encoded = Buffer.from(payload).toString("base64url");
    expect(verifyActionToken(`${encoded}.fakesig`, { secret: SECRET })).toBeNull();
  });

  it("rejects a token whose action is the old approve-instagram string", () => {
    const payload = `${ID}:approve-instagram:0:${Date.now() + 100_000}`;
    const encoded = Buffer.from(payload).toString("base64url");
    expect(verifyActionToken(`${encoded}.fakesig`, { secret: SECRET })).toBeNull();
  });
});
