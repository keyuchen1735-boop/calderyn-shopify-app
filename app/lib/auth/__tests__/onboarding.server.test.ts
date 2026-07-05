import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizePhone,
  isReferralSource,
  REFERRAL_SOURCES,
  saveOnboardingContact,
  completeOnboarding,
  getOnboardingProgress,
} from "../onboarding.server";

const update = vi.fn();
const updateEq = vi.fn();
const select = vi.fn();
const selectEq = vi.fn();
const maybeSingle = vi.fn();
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ update, select }) }),
}));

beforeEach(() => {
  updateEq.mockReset().mockResolvedValue({ error: null });
  update.mockReset().mockReturnValue({ eq: updateEq });
  maybeSingle.mockReset().mockResolvedValue({ data: null, error: null });
  selectEq.mockReset().mockReturnValue({ maybeSingle });
  select.mockReset().mockReturnValue({ eq: selectEq });
});

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

// Onboarding is a two-step flow: step 1 saves contact (phone + referral) but does
// NOT mark the user onboarded; step 2 (the import choice) is what completes it.
// Keeping onboarded_at off the contact write is what lets the gate hold the user
// on the import step until they connect or explicitly skip.
describe("saveOnboardingContact", () => {
  it("writes phone + referral scoped by user id, but does NOT set onboarded_at", async () => {
    await saveOnboardingContact("u1", {
      phone: "+14155550123",
      referralSource: "google_search",
      referralOther: null,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "+14155550123",
        referral_source: "google_search",
        referral_source_other: null,
      }),
    );
    // The contact step must not flip the completion flag — that is step 2's job.
    expect(update.mock.calls[0][0]).not.toHaveProperty("onboarded_at");
    expect(updateEq).toHaveBeenCalledWith("id", "u1");
  });

  it("persists free text only when the source is 'other'", async () => {
    await saveOnboardingContact("u1", {
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
    updateEq.mockResolvedValueOnce({ error: { message: "boom" } });
    await expect(
      saveOnboardingContact("u1", { phone: "4155550123", referralSource: "youtube", referralOther: null }),
    ).rejects.toBeTruthy();
  });
});

describe("completeOnboarding", () => {
  it("sets onboarded_at scoped by user id, and touches nothing else", async () => {
    await completeOnboarding("u1");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarded_at: expect.any(String) }),
    );
    // Completion only flips the flag; it must not clobber the saved contact fields.
    expect(update.mock.calls[0][0]).not.toHaveProperty("phone");
    expect(update.mock.calls[0][0]).not.toHaveProperty("referral_source");
    expect(updateEq).toHaveBeenCalledWith("id", "u1");
  });

  it("throws when the update errors", async () => {
    updateEq.mockResolvedValueOnce({ error: { message: "boom" } });
    await expect(completeOnboarding("u1")).rejects.toBeTruthy();
  });
});

describe("getOnboardingProgress", () => {
  it("returns the saved phone for the user, scoped by id", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { phone: "4155550123" }, error: null });
    const p = await getOnboardingProgress("u1");
    expect(p).toEqual({ phone: "4155550123" });
    expect(selectEq).toHaveBeenCalledWith("id", "u1");
  });

  it("returns a null phone when the row is missing", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect(await getOnboardingProgress("u1")).toEqual({ phone: null });
  });

  it("throws on a read error", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(getOnboardingProgress("u1")).rejects.toBeTruthy();
  });
});
