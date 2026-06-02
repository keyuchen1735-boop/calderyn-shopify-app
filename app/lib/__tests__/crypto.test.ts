import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  // 32-byte key as 64 hex chars
  process.env.INTEGRATION_ENCRYPTION_KEY = "0".repeat(64);
});

describe("crypto.server", () => {
  it("round-trips plaintext", async () => {
    const { encrypt, decrypt } = await import("../crypto.server");
    const secret = "EAALongLivedToken123";
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it("produces a different ciphertext each call (random IV)", async () => {
    const { encrypt } = await import("../crypto.server");
    expect(encrypt("x")).not.toBe(encrypt("x"));
  });

  it("throws on a tampered ciphertext", async () => {
    const { encrypt, decrypt } = await import("../crypto.server");
    const ct = encrypt("secret");
    const tampered = ct.slice(0, -2) + (ct.endsWith("aa") ? "bb" : "aa");
    expect(() => decrypt(tampered)).toThrow();
  });
});
