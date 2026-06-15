import { describe, it, expect, beforeEach, vi } from "vitest";
import { SignJWT } from "jose";

const limit = vi.fn().mockResolvedValue({ data: null, error: { message: "db down" } });
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ limit }) }),
    }),
  }),
}));

beforeEach(() => { process.env.PILOT_UNSUB_SECRET = "unit-test-secret"; });

describe("unsub token", () => {
  it("round-trips the email", async () => {
    const { signUnsubToken, verifyUnsubToken } = await import("../unsubscribe.server");
    const token = await signUnsubToken("Jane@Store.com");
    expect(await verifyUnsubToken(token)).toBe("jane@store.com");
  });
  it("rejects a tampered token", async () => {
    const { signUnsubToken, verifyUnsubToken } = await import("../unsubscribe.server");
    const token = await signUnsubToken("a@b.co");
    expect(await verifyUnsubToken(token + "x")).toBeNull();
  });
  it("rejects a valid JWT with the wrong purpose", async () => {
    const { verifyUnsubToken } = await import("../unsubscribe.server");
    const key = new TextEncoder().encode(process.env.PILOT_UNSUB_SECRET);
    const token = await new SignJWT({ purpose: "other" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("a@b.co")
      .setIssuedAt()
      .sign(key);
    expect(await verifyUnsubToken(token)).toBeNull();
  });
});

describe("isOptedOut", () => {
  it("surfaces a Supabase error (fail-closed contract)", async () => {
    const { isOptedOut } = await import("../unsubscribe.server");
    const result = await isOptedOut("a@b.co");
    expect(result).toEqual({ optedOut: false, error: "db down" });
  });
});
