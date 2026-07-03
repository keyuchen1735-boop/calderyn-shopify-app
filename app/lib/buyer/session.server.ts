// app/lib/buyer/session.server.ts
//
// Buyer-side session primitive (platform pivot #1b). This is a SEPARATE namespace from the
// merchant dashboard session (lib/dashboard/session.server.ts): its own table (buyer_session),
// its own cookie (__Host-calderyn_buyer, distinct from the dashboard's __Host-calderyn_dash),
// its own pepper (BUYER_SESSION_PEPPER). It MIRRORS the dashboard session's SECURITY POSTURE —
// opaque bearer token in a __Host- cookie, only the peppered HMAC-SHA256 hash stored, TTL +
// revocation — but never shares its cookie, secret, or table, so a buyer can never assume a
// merchant session and vice versa.
//
// Buyer identity is PER-SHOP (buyer_dim is unique per (shop_id, email)); every read here threads
// shop_id so a session token can only resolve within the shop it was minted for. The storefront
// is served per-shop-host, so the __Host- cookie (host-scoped, no Domain) is naturally isolated
// to one shop's storefront — the DB shop scope is defense-in-depth on top of that.

import { redirect } from "@remix-run/node";
import { createHmac, randomBytes } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";

export const BUYER_SESSION_COOKIE_NAME = "__Host-calderyn_buyer";
const BUYER_SESSION_TTL_MS = 30 * 86_400_000; // 30 days

function pepper(): string {
  const p = process.env.BUYER_SESSION_PEPPER;
  if (!p || p.length < 32) {
    throw new Error("BUYER_SESSION_PEPPER must be set to a 32+ char secret");
  }
  return p;
}

const BASE32_ALPHA = "abcdefghijklmnopqrstuvwxyz234567";

export function newBuyerSessionToken(): string {
  // 32 random bytes → 32 base32 chars; 256 % 32 === 0 so `byte % 32` is unbiased.
  const bytes = randomBytes(32);
  let body = "";
  for (let i = 0; i < bytes.length; i++) body += BASE32_ALPHA[bytes[i] % 32];
  return `buyer_live_${body}`;
}

export function hashBuyerToken(raw: string): string {
  return createHmac("sha256", pepper()).update(raw).digest("hex");
}

export function buyerSessionCookieHeader(raw: string): string {
  const maxAge = Math.floor(BUYER_SESSION_TTL_MS / 1000);
  return `${BUYER_SESSION_COOKIE_NAME}=${raw}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearBuyerSessionCookieHeader(): string {
  return `${BUYER_SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function readBuyerSessionTokenFromCookie(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === BUYER_SESSION_COOKIE_NAME) return rest.join("=") || null;
  }
  return null;
}

/** Mint a buyer session for (shop, buyer) and return the RAW token to set in the cookie. */
export async function createBuyerSession(shopId: string, buyerId: string): Promise<{ raw: string }> {
  if (!shopId) throw new Error("shopId is required");
  if (!buyerId) throw new Error("buyerId is required");
  const raw = newBuyerSessionToken();
  const { error } = await getSupabase()
    .from("buyer_session")
    .insert({
      shop_id: shopId,
      buyer_id: buyerId,
      token_hash: hashBuyerToken(raw),
      expires_at: new Date(Date.now() + BUYER_SESSION_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { raw };
}

export interface BuyerSession {
  shopId: string;
  buyerId: string;
  sessionId: string;
}

/**
 * Resolve the live buyer session for this request WITHIN the given shop, or null. Scoped to
 * shopId so a token minted for another shop resolves to nothing here. Rejects a revoked or
 * expired session.
 */
export async function getBuyerSession(request: Request, shopId: string): Promise<BuyerSession | null> {
  if (!shopId) return null;
  const raw = readBuyerSessionTokenFromCookie(request);
  if (!raw) return null;

  const { data, error } = await getSupabase()
    .from("buyer_session")
    .select("id, shop_id, buyer_id, expires_at, revoked_at")
    .eq("shop_id", shopId)
    .eq("token_hash", hashBuyerToken(raw))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.revoked_at) return null;
  if (new Date(String(data.expires_at)).getTime() <= Date.now()) return null;

  return {
    shopId: String(data.shop_id),
    buyerId: String(data.buyer_id),
    sessionId: String(data.id),
  };
}

/** For HTML account routes: send a signed-out buyer to the login page. */
export async function requireBuyerSession(request: Request, shopId: string): Promise<BuyerSession> {
  const session = await getBuyerSession(request, shopId);
  if (!session) throw redirect("/storefront/account/login");
  return session;
}

export async function revokeBuyerSession(sessionId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("buyer_session")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", sessionId);
  if (error) throw error;
}

/** Kill every live session for a buyer (e.g. on account deletion). */
export async function revokeAllBuyerSessions(shopId: string, buyerId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("buyer_session")
    .update({ revoked_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("buyer_id", buyerId)
    .is("revoked_at", null);
  if (error) throw error;
}
