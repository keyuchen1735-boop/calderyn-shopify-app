// app/lib/auth/users.server.ts
import { getSupabase } from "../supabase.server";
import { hashPassword, verifyPassword } from "./password.server";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A fixed valid hash used to spend ~the same CPU when the email is unknown, so
// login timing does not reveal whether an account exists.
const DUMMY_HASH = hashPassword("calderyn-anti-enumeration-placeholder");

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(raw: string): boolean {
  return EMAIL_RE.test(raw.trim());
}

export async function findUserByEmail(
  email: string,
): Promise<{ id: string; passwordHash: string | null; onboardedAt: string | null } | null> {
  const { data, error } = await getSupabase()
    .from("users")
    .select("id, password_hash, onboarded_at")
    .eq("email", normalizeEmail(email))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: String(data.id),
    // Google-only accounts have a NULL password_hash — keep it null (not the
    // literal string "null") so credential checks can spend equal CPU on it.
    passwordHash: data.password_hash == null ? null : String(data.password_hash),
    onboardedAt: (data.onboarded_at as string | null) ?? null,
  };
}

export async function createUser(
  email: string,
  password: string,
): Promise<{ id: string }> {
  const { data, error } = await getSupabase()
    .from("users")
    .insert({ email: normalizeEmail(email), password_hash: hashPassword(password) })
    .select("id")
    .single();
  if (error) throw error;
  return { id: String(data.id) };
}

export async function deleteUser(id: string): Promise<void> {
  const { error } = await getSupabase().from("users").delete().eq("id", id);
  if (error) throw error;
}

export async function verifyUserCredentials(
  email: string,
  password: string,
): Promise<{ id: string } | null> {
  const user = await findUserByEmail(email);
  // Unknown email OR a passwordless (Google-only) account: spend the same scrypt
  // CPU against a dummy hash so response timing can't tell either case apart from
  // a real password account. Without this, a Google-only account skipped scrypt
  // entirely (its NULL hash fails the format check) and answered noticeably
  // faster, enumerating which addresses are Google sign-in accounts.
  if (!user || user.passwordHash == null) {
    verifyPassword(password, DUMMY_HASH); // burn comparable CPU; ignore result
    return null;
  }
  return verifyPassword(password, user.passwordHash) ? { id: user.id } : null;
}

export async function findUserByGoogleSub(
  sub: string,
): Promise<{ id: string; shopId: string | null; onboardedAt: string | null } | null> {
  const { data, error } = await getSupabase()
    .from("users")
    .select("id, membership(shop_id), onboarded_at")
    .eq("google_sub", sub)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const m = (data.membership as { shop_id?: string }[] | { shop_id?: string } | null);
  const shopId = Array.isArray(m) ? (m[0]?.shop_id ?? null) : (m?.shop_id ?? null);
  return {
    id: String(data.id),
    shopId: shopId == null ? null : String(shopId),
    onboardedAt: (data.onboarded_at as string | null) ?? null,
  };
}

export async function setGoogleSub(userId: string, sub: string): Promise<void> {
  const { error } = await getSupabase()
    .from("users")
    // Linking a Google identity proves Google-verified mailbox ownership (the
    // sign-in callback only links after asserting emailVerified), so mark the
    // email verified — otherwise a password user who never clicked the verify
    // link stays trapped at the verify gate even after signing in with Google.
    .update({ google_sub: sub, email_verified: true, updated_at: new Date().toISOString() })
    .eq("id", userId);
  if (error) throw error;
}

export async function createGoogleUser(email: string, sub: string): Promise<{ id: string }> {
  const { data, error } = await getSupabase()
    .from("users")
    .insert({ email: normalizeEmail(email), google_sub: sub, email_verified: true })
    .select("id")
    .single();
  if (error) throw error;
  return { id: String(data.id) };
}
