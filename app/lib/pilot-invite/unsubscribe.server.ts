// app/lib/pilot-invite/unsubscribe.server.ts
// HS256 unsub token (same jose pattern as mcp_oauth.server.ts) + Supabase suppression list.
// Every Supabase call degrades to a surfaced error and never throws (rule 12).
import { SignJWT, jwtVerify } from "jose";
import { getSupabase } from "~/lib/supabase.server";

function unsubKey(): Uint8Array {
  const secret = process.env.PILOT_UNSUB_SECRET;
  if (!secret) throw new Error("PILOT_UNSUB_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export async function signUnsubToken(email: string): Promise<string> {
  return new SignJWT({ purpose: "pilot-unsub" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email.toLowerCase())
    .setIssuedAt()
    // Long expiry so the "invalid or expired" copy on /pilot/unsubscribe is
    // accurate, while staying well within RFC 8058 one-click-unsubscribe norms.
    .setExpirationTime("180d")
    .sign(unsubKey());
}

/** Returns the lowercased email if the token is valid + purpose-scoped, else null. */
export async function verifyUnsubToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, unsubKey(), { algorithms: ["HS256"] });
    if (payload.purpose !== "pilot-unsub" || typeof payload.sub !== "string") return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export async function recordOptOut(email: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await getSupabase()
      .from("email_optouts")
      .upsert({ email: email.toLowerCase(), reason: reason ?? null, source: "pilot" }, { onConflict: "email" });
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** optedOut=false with a set `error` means "could not verify" — callers must fail closed. */
export async function isOptedOut(email: string): Promise<{ optedOut: boolean; error?: string }> {
  try {
    const { data, error } = await getSupabase()
      .from("email_optouts").select("email").eq("email", email.toLowerCase()).limit(1);
    return error ? { optedOut: false, error: error.message } : { optedOut: (data?.length ?? 0) > 0 };
  } catch (e) {
    return { optedOut: false, error: e instanceof Error ? e.message : String(e) };
  }
}
