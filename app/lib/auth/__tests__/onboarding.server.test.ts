import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizePhone,
  isReferralSource,
  REFERRAL_SOURCES,
  setOnboardingProfile,
} from "../onboarding.server";

const update = vi.fn();
const eq = vi.fn();
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ update }) }),
}));

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

describe("setOnboardingProfile", () => {
  beforeEach(() => {
    eq.mockReset().mockResolvedValue({ error: null });
    update.mockReset().mockReturnValue({ eq });
  });

  it("writes the four columns incl. onboarded_at, scoped by user id", async () => {
    await setOnboardingProfile("u1", {
      phone: "+14155550123",
      referralSource: "google_search",
      referralOther: null,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "+14155550123",
        referral_source: "google_search",
        referral_source_other: null,
        onboarded_at: expect.any(String),
      }),
    );
    expect(eq).toHaveBeenCalledWith("id", "u1");
  });

  it("persists free text only when the source is 'other'", async () => {
    await setOnboardingProfile("u1", {
      phone: "4155550123",
      referralSource: "other",
      referralOther: "a friend at a meetup",
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        referral_source: "other",
        referral_source_other: "a friend at a meetup",
      }),
    );
  });

  it("throws when the update errors", async () => {
    eq.mockResolvedValueOnce({ error: { message: "boom" } });
    await expect(
      setOnboardingProfile("u1", { phone: "4155550123", referralSource: "youtube", referralOther: null }),
    ).rejects.toBeTruthy();
  });
});
