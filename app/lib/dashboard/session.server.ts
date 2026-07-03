// app/lib/dashboard/session.server.ts
//
// Sessions for the merchant web dashboard. Opaque bearer token in a __Host-
// cookie; only its peppered HMAC-SHA256 hash is stored (same pattern as
// mcp_tokens.server.ts). Session identity is the SHOP, not a person (v1).

import { redirect } from "@remix-run/node";
import { createHmac, randomBytes } from "node:crypto";
import { getSupabase, resolveShopId } from "../supabase.server";
import { resurfaceAllSnoozes } from "../actions/snooze.server";
import { expireCookieHeader } from "./cookies.server";

export const SESSION_COOKIE_NAME = "__Host-calderyn_dash";
const SESSION_TTL_MS = 30 * 86_400_000; // 30 days

function pepper(): string {
  const p = process.env.DASHBOARD_SESSION_PEPPER;
  if (!p || p.length < 32) {
    throw new Error("DASHBOARD_SESSION_PEPPER must be set to a 32+ char secret");
  }
  return p;
}

const BASE32_ALPHA = "abcdefghijklmnopqrstuvwxyz234567";

export function newSessionToken(): string {
  // 32 random bytes → 32 base32 chars; 256 % 32 === 0 so `byte % 32` is unbiased.
  const bytes = randomBytes(32);
  let body = "";
  for (let i = 0; i < bytes.length; i++) body += BASE32_ALPHA[bytes[i] % 32];
  return `dash_live_${body}`;
}

export function hashSessionToken(raw: string): string {
  return createHmac("sha256", pepper()).update(raw).digest("hex");
}

export function sessionCookieHeader(raw: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE_NAME}=${raw}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookieHeader(): string {
  return expireCookieHeader(SESSION_COOKIE_NAME);
}

export function readSessionTokenFromCookie(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) return rest.join("=") || null;
  }
  return null;
}

export async function createSession(shopDomain: string): Promise<{ raw: string }> {
  const shopId = await resolveShopId(shopDomain);
  const raw = newSessionToken();
  const { error } = await getSupabase()
    .from("dashboard_sessions")
    .insert({
      shop_id: shopId,
      shop_domain: shopDomain,
      token_hash: hashSessionToken(raw),
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;

  // A fresh login re-surfaces any alerts snoozed in a prior session — snooze
  // hides an alert until +1 day OR the next login, whichever comes first.
  // Best-effort (resurfaceAllSnoozes swallows + logs its own errors).
  await resurfaceAllSnoozes(getSupabase(), shopId);

  return { raw };
}

export type DashboardSession = {
  shopId: string;
  shopDomain: string | null;
  userId: string | null;
  sessionId: string;
  emailVerified: boolean;
};

export async function getSessionFromRequest(
  request: Request,
): Promise<DashboardSession | null> {
  const raw = readSessionTokenFromCookie(request);
  if (!raw) return null;

  const sb = getSupabase();
  const { data, error } = await sb
    .from("dashboard_sessions")
    .select("id, shop_id, shop_domain, user_id, expires_at, revoked_at, user:users(email_verified)")
    .eq("token_hash", hashSessionToken(raw))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.revoked_at) return null;
  if (new Date(String(data.expires_at)).getTime() <= Date.now()) return null;

  // Sliding activity marker; failure here must not block the request.
  try {
    await sb
      .from("dashboard_sessions")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", data.id);
  } catch {
    /* best effort */
  }

  return {
    shopId: String(data.shop_id),
    shopDomain: data.shop_domain == null ? null : String(data.shop_domain),
    userId: data.user_id == null ? null : String(data.user_id),
    sessionId: String(data.id),
    emailVerified: data.user_id == null ? true : Boolean((data.user as { email_verified?: boolean } | null)?.email_verified),
  };
}

function unverifiedFirstParty(s: DashboardSession): boolean {
  return s.userId != null && !s.emailVerified;
}

export async function getDashboardSessionAllowUnverified(
  request: Request,
): Promise<DashboardSession> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    throw new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return session;
}

export async function requireVerifiedSession(
  request: Request,
): Promise<DashboardSession> {
  const session = await getSessionFromRequest(request);
  // Signed-out visitors land on the first-party signin page, which links out to
  // the Shopify-OAuth entry (/dashboard/login) for embedded merchants.
  if (!session) throw redirect("/login");
  if (unverifiedFirstParty(session)) throw redirect("/dashboard/verify-needed");
  return session;
}

/** Throws a 401 JSON Response when there is no live session, or 403 when the
 *  first-party user has not yet verified their email address. */
export async function requireDashboardSession(
  request: Request,
): Promise<DashboardSession> {
  const session = await getDashboardSessionAllowUnverified(request);
  if (unverifiedFirstParty(session)) {
    throw new Response(JSON.stringify({ error: "email_unverified" }), {
      status: 403,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return session;
}

/** For HTML routes: redirect to the signin page when there is no live session. */
export async function getSessionOrRedirect(
  request: Request,
): Promise<DashboardSession> {
  const session = await getSessionFromRequest(request);
  if (!session) throw redirect("/login");
  return session;
}

export async function revokeSession(sessionId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("dashboard_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", sessionId);
  if (error) throw error;
}

export async function revokeAllSessionsForShop(shopDomain: string): Promise<void> {
  const { error } = await getSupabase()
    .from("dashboard_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("shop_domain", shopDomain)
    .is("revoked_at", null);
  if (error) throw error;
}

export async function createSessionForUser(
  userId: string,
  shopId: string,
): Promise<{ raw: string }> {
  const raw = newSessionToken();
  const { error } = await getSupabase()
    .from("dashboard_sessions")
    .insert({
      user_id: userId,
      shop_id: shopId,
      token_hash: hashSessionToken(raw),
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  await resurfaceAllSnoozes(getSupabase(), shopId);
  return { raw };
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("dashboard_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw error;
}
