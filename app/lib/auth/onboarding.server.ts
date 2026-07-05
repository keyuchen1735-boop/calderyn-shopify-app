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

export interface OnboardingContact {
  phone: string;
  referralSource: ReferralSource;
  referralOther: string | null;
}

/**
 * Step 1: persist phone + referral. Deliberately does NOT set onboarded_at — the
 * gate keys on onboarded_at, so leaving it null keeps the user on the import step
 * (step 2) until they connect or explicitly skip. completeOnboarding() flips it.
 */
export async function saveOnboardingContact(
  userId: string,
  contact: OnboardingContact,
): Promise<void> {
  const { error } = await getSupabase()
    .from("users")
    .update({
      phone: contact.phone,
      referral_source: contact.referralSource,
      referral_source_other: contact.referralSource === "other" ? contact.referralOther : null,
    })
    .eq("id", userId);
  if (error) throw error;
}

/** Step 2: mark the user onboarded once the import step has been answered. */
export async function completeOnboarding(userId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("users")
    .update({ onboarded_at: new Date().toISOString() })
    .eq("id", userId);
  if (error) throw error;
}

/** Which onboarding step a user is on: phone present ⇒ contact done (show import). */
export async function getOnboardingProgress(
  userId: string,
): Promise<{ phone: string | null }> {
  const { data, error } = await getSupabase()
    .from("users")
    .select("phone")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return { phone: (data?.phone as string | null) ?? null };
}
