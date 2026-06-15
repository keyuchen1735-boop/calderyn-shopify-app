import { describe, it, expect, beforeEach, vi } from "vitest";

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
});
