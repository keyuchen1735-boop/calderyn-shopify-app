// app/lib/auth/verify.server.ts
import { getSupabase } from "../supabase.server";
import { newSessionToken, hashSessionToken } from "../dashboard/session.server";
import { sendEmail } from "../email/send.server";

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function createVerifyToken(userId: string): Promise<{ raw: string }> {
  const raw = newSessionToken();
  const { error } = await getSupabase()
    .from("password_reset_token")
    .insert({
      user_id: userId,
      token_hash: hashSessionToken(raw),
      purpose: "verify",
      expires_at: new Date(Date.now() + VERIFY_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { raw };
}

export async function consumeVerifyToken(raw: string): Promise<{ userId: string } | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("password_reset_token")
    .select("id, user_id, purpose, expires_at, used_at")
    .eq("token_hash", hashSessionToken(raw))
    .maybeSingle();
  if (error) throw error;
  if (!data || data.purpose !== "verify" || data.used_at) return null;
  if (new Date(String(data.expires_at)).getTime() <= Date.now()) return null;
  const { error: ue } = await sb
    .from("password_reset_token")
    .update({ used_at: new Date().toISOString() })
    .eq("id", data.id);
  if (ue) throw ue;
  return { userId: String(data.user_id) };
}

export async function markEmailVerified(userId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("users")
    .update({ email_verified: true, updated_at: new Date().toISOString() })
    .eq("id", userId);
  if (error) throw error;
}

export async function sendVerificationEmail(userId: string, email: string, baseUrl: string): Promise<void> {
  const { raw } = await createVerifyToken(userId);
  const link = `${baseUrl}/dashboard/verify?t=${encodeURIComponent(raw)}`;
  const result = await sendEmail({
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.PILOT_FROM ?? "Calderyn <onboarding@calderyncompany.com>",
    to: email,
    subject: "Verify your Calderyn email",
    text: `Confirm your email to unlock your dashboard (link valid for 24 hours):\n\n${link}\n\nIf you didn't create a Calderyn account, ignore this email.`,
  });
  // Callers deliberately swallow rejections so signup never fails on email
  // trouble — but an unverified user is locked out of the dashboard until this
  // arrives, so a delivery failure must at least reach the server logs.
  if (!result.sent) {
    console.error(`[verify-email] delivery failed for user ${userId}: ${result.error ?? "unknown error"}`);
  }
}
