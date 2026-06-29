import { describe, it, expect, vi } from "vitest";
import { signGoogleSignup, verifyGoogleSignup } from "../google-signup-token.server";

process.env.DASHBOARD_SESSION_PEPPER = "x".repeat(32);

describe("google signup token", () => {
  it("round-trips a valid token", () => {
    const t = signGoogleSignup({ sub: "g123", email: "a@b.co" });
    expect(verifyGoogleSignup(t)).toEqual({ sub: "g123", email: "a@b.co" });
  });
  it("rejects a tampered token", () => {
    const t = signGoogleSignup({ sub: "g123", email: "a@b.co" });
    const tampered = t.slice(0, -3) + (t.slice(-3) === "aaa" ? "bbb" : "aaa");
    expect(verifyGoogleSignup(tampered)).toBeNull();
  });
  it("returns null for malformed input", () => {
    expect(verifyGoogleSignup("")).toBeNull();
    expect(verifyGoogleSignup("not.a.token")).toBeNull();
  });
  it("rejects an expired token", () => {
    vi.useFakeTimers();
    try {
      const t = signGoogleSignup({ sub: "g1", email: "a@b.co" });
      vi.advanceTimersByTime(16 * 60 * 1000); // past the 15 min TTL
      expect(verifyGoogleSignup(t)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
