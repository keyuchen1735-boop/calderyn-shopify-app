// app/lib/auth/reset.server.ts
//
// Password-reset token lifecycle: mint, consume (single-use, 1h TTL), and the
// two public entrypoints (requestPasswordReset, setPasswordWithToken).
// Tokens are hashed at rest with the same HMAC pattern as dashboard sessions.

import { getSupabase } from "../supabase.server";
import { findUserByEmail } from "./users.server";
import { hashPassword } from "./password.server";
import { newSessionToken, hashSessionToken, revokeAllSessionsForUser } from "../dashboard/session.server";
import { sendEmail } from "../email/send.server";

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function createResetToken(
  userId: string,
  purpose: "reset" | "set_password" = "reset",
): Promise<{ raw: string }> {
  const raw = newSessionToken();
  const { error } = await getSupabase()
    .from("password_reset_token")
    .insert({
      user_id: userId,
      token_hash: hashSessionToken(raw),
      purpose,
      expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { raw };
}

export async function consumeResetToken(raw: string): Promise<{ userId: string } | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("password_reset_token")
    .select("id, user_id, purpose, expires_at, used_at")
    .eq("token_hash", hashSessionToken(raw))
    .in("purpose", ["reset", "set_password"]) // a verify token must never set a password
    .maybeSingle();
  if (error) throw error;
  if (!data || data.used_at) return null;
  // Scope guard: a password-set token must NOT be satisfiable by a verify-purpose
  // token, which shares this table but has a longer (24h) TTL and only proves
  // mailbox control. Without this, a leaked verify link is a full ATO primitive.
  if (data.purpose !== "reset" && data.purpose !== "set_password") return null;
  if (new Date(String(data.expires_at)).getTime() <= Date.now()) return null;
  // Atomic single-use claim: the UPDATE itself is the guard (used_at IS NULL), so
  // two concurrent consumers of the same token can't both succeed.
  const { data: claimed, error: updateError } = await sb
    .from("password_reset_token")
    .update({ used_at: new Date().toISOString() })
    .eq("id", data.id)
    .is("used_at", null)
    .select("id")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!claimed) return null; // lost the race — already consumed
  return { userId: String(data.user_id) };
}

export async function requestPasswordReset(email: string, baseUrl: string): Promise<void> {
  const user = await findUserByEmail(email);
  if (!user) return; // silent: never reveal whether the email exists
  const { raw } = await createResetToken(user.id, "reset");
  const link = `${baseUrl}/dashboard/reset/confirm?t=${encodeURIComponent(raw)}`;
  await sendEmail({
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.PILOT_FROM ?? "Calderyn <onboarding@calderyncompany.com>",
    to: email,
    subject: "Reset your Calderyn password",
    text: `Use this link to set a new password (valid for 1 hour):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
  });
}

export async function setPasswordWithToken(raw: string, newPassword: string): Promise<boolean> {
  const consumed = await consumeResetToken(raw);
  if (!consumed) return false;
  const { error } = await getSupabase()
    .from("users")
    .update({ password_hash: hashPassword(newPassword), updated_at: new Date().toISOString() })
    .eq("id", consumed.userId);
  if (error) throw error;
  // Security: a password reset must kill every existing session for this user,
  // so a stolen or forgotten login cannot survive the reset.
  // If revocation throws, we surface a 500 rather than swallowing it: the
  // password has already changed, but leaving old sessions alive silently
  // is worse than forcing the merchant to retry.
  await revokeAllSessionsForUser(consumed.userId);
  return true;
}
