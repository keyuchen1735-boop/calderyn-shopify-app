// app/lib/auth/onboarding.server.ts
import { getSupabase } from "../supabase.server";

export const REFERRAL_SOURCES = [
  "google_search",
  "shopify_app_store",
  "twitter_x",
  "linkedin",
  "youtube",
  "tiktok_instagram",
  "friend_colleague",
  "other",
] as const;
export type ReferralSource = (typeof REFERRAL_SOURCES)[number];

export function isReferralSource(x: unknown): x is ReferralSource {
  return typeof x === "string" && (REFERRAL_SOURCES as readonly string[]).includes(x);
}

/**
 * Light E.164 normalization: keep a single leading `+` when present and the digits,
 * require 7–15 digits (the E.164 range), and return `+<digits>` (or `<digits>` when no
 * `+` was given). Returns null when the input can't be a phone number. Deliberately not
 * a full libphonenumber validation — v1 only guards obviously-bad input.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return hasPlus ? `+${digits}` : digits;
}

export interface OnboardingProfile {
  phone: string;
  referralSource: ReferralSource;
  referralOther: string | null;
}

/** Persist the onboarding profile and mark the user onboarded, in one update. */
export async function setOnboardingProfile(
  userId: string,
  profile: OnboardingProfile,
): Promise<void> {
  const { error } = await getSupabase()
    .from("users")
    .update({
      phone: profile.phone,
      referral_source: profile.referralSource,
      referral_source_other: profile.referralSource === "other" ? profile.referralOther : null,
      onboarded_at: new Date().toISOString(),
    })
    .eq("id", userId);
  if (error) throw error;
}
