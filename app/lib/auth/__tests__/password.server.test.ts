process.env.PASSWORD_PEPPER = "x".repeat(32);

import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../password.server";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("produces a different hash each call (random salt)", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("returns false for malformed stored values instead of throwing", () => {
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "not-a-scrypt-hash")).toBe(false);
  });
});
