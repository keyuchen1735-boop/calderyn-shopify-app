import { describe, it, expect } from "vitest";
import { normalizePhone, isReferralSource, REFERRAL_SOURCES } from "../onboarding.server";

describe("normalizePhone", () => {
  it("normalizes an international number, preserving the leading +", () => {
    expect(normalizePhone("+1 415 555 0123")).toBe("+14155550123");
  });
  it("strips punctuation when no + is given", () => {
    expect(normalizePhone("(415) 555-0123")).toBe("4155550123");
  });
  it("rejects a too-short number", () => {
    expect(normalizePhone("12345")).toBeNull();
  });
  it("rejects a too-long number (>15 digits)", () => {
    expect(normalizePhone("1234567890123456")).toBeNull();
  });
  it("rejects blank input", () => {
    expect(normalizePhone("   ")).toBeNull();
  });
});

describe("isReferralSource", () => {
  it("accepts every known key", () => {
    for (const k of REFERRAL_SOURCES) expect(isReferralSource(k)).toBe(true);
  });
  it("rejects an unknown key", () => {
    expect(isReferralSource("myspace")).toBe(false);
  });
  it("rejects non-strings", () => {
    expect(isReferralSource(42)).toBe(false);
  });
});
