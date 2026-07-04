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
): Promise<{ id: string; passwordHash: string; emailVerified: boolean } | null> {
  const { data, error } = await getSupabase()
    .from("users")
    .select("id, password_hash, email_verified")
    .eq("email", normalizeEmail(email))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: String(data.id),
    passwordHash: String(data.password_hash),
    emailVerified: Boolean(data.email_verified),
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
  if (!user) {
    verifyPassword(password, DUMMY_HASH); // burn comparable CPU; ignore result
    return null;
  }
  return verifyPassword(password, user.passwordHash) ? { id: user.id } : null;
}

export async function findUserByGoogleSub(
  sub: string,
): Promise<{ id: string; shopId: string | null } | null> {
  const { data, error } = await getSupabase()
    .from("users")
    .select("id, membership(shop_id)")
    .eq("google_sub", sub)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const m = (data.membership as { shop_id?: string }[] | { shop_id?: string } | null);
  const shopId = Array.isArray(m) ? (m[0]?.shop_id ?? null) : (m?.shop_id ?? null);
  return { id: String(data.id), shopId: shopId == null ? null : String(shopId) };
}

export async function setGoogleSub(userId: string, sub: string): Promise<void> {
  const { error } = await getSupabase()
    .from("users")
    .update({ google_sub: sub, updated_at: new Date().toISOString() })
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
