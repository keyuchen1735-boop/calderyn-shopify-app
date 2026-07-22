// app/lib/auth/remembered-accounts.server.ts
//
// The multi-account chooser on /login. The browser keeps the raw session
// tokens of accounts previously signed in on this device in one HttpOnly
// __Host- cookie; the server resolves them to live sessions (email + store
// name) at render time and prunes anything expired or revoked. Nothing but
// opaque tokens ever sits in the cookie — display data is looked up fresh so
// it can't go stale or leak into script-readable storage. Trust model matches
// Shopify/Google account pickers: possession of the device grants one-click
// entry to each account until its server-side session expires (30 days) or is
// revoked.

import { getSupabase } from "../supabase.server";
import { hashSessionToken } from "../dashboard/session.server";
import { expireCookieHeader, ACCOUNTS_COOKIE_NAME } from "../dashboard/cookies.server";

export { ACCOUNTS_COOKIE_NAME };

/** Accounts shown in the chooser (and kept after a resolve pass). */
export const MAX_ACCOUNTS = 5;
/** Raw tokens kept between resolve passes — repeat sign-ins by the same user
 *  stack up until /login dedupes them, so allow a little headroom. */
const MAX_STORED = 8;
// Matches the session TTL: a token older than this is dead server-side anyway.
const COOKIE_MAX_AGE = 30 * 86_400;

// Same shape newSessionToken() mints. Anything else in the cookie is junk
// (tampering, truncation) and is dropped on read.
const TOKEN_RE = /^dash_live_[a-z2-7]{32}$/;

export function readRememberedTokens(request: Request): string[] {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === ACCOUNTS_COOKIE_NAME) {
      return rest
        .join("=")
        .split("|")
        .map((t) => t.trim())
        .filter((t) => TOKEN_RE.test(t))
        .slice(0, MAX_STORED);
    }
  }
  return [];
}

export function rememberedAccountsCookieHeader(tokens: string[]): string {
  if (tokens.length === 0) return clearRememberedAccountsCookieHeader();
  const value = tokens.slice(0, MAX_STORED).join("|");
  return `${ACCOUNTS_COOKIE_NAME}=${value}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearRememberedAccountsCookieHeader(): string {
  return expireCookieHeader(ACCOUNTS_COOKIE_NAME);
}

/** Set-Cookie for a successful sign-in: the fresh token goes first (newest
 *  wins in the chooser), previous entries follow. No DB round-trip here —
 *  identity-level dedupe happens on the next /login resolve. */
export function rememberOnSignIn(request: Request, newRaw: string): string {
  const existing = readRememberedTokens(request).filter((t) => t !== newRaw);
  return rememberedAccountsCookieHeader([newRaw, ...existing]);
}

/** Set-Cookie for logout: drop every token belonging to the signed-out
 *  account (not just the active one — a stale earlier sign-in of the same
 *  account must not survive an explicit logout as a one-click entry) while the
 *  other remembered accounts keep theirs. Falls back to an exact-token filter
 *  if the identity lookup fails: logout must never 500 over a prune. */
export async function rememberOnSignOut(
  request: Request,
  activeRaw: string | null,
): Promise<string> {
  const tokens = readRememberedTokens(request);
  const withoutActive = tokens.filter((t) => t !== activeRaw);
  if (!activeRaw || withoutActive.length === 0) {
    return rememberedAccountsCookieHeader(withoutActive);
  }
  try {
    const rows = await fetchRows([activeRaw, ...withoutActive]);
    const active = rows.get(hashSessionToken(activeRaw));
    if (!active) return rememberedAccountsCookieHeader(withoutActive);
    const identity = active.user_id ? `u:${active.user_id}` : `s:${active.shop_id}`;
    const kept = withoutActive.filter((t) => {
      const row = rows.get(hashSessionToken(t));
      if (!row) return true; // unknown → let the next /login resolve decide
      return (row.user_id ? `u:${row.user_id}` : `s:${row.shop_id}`) !== identity;
    });
    return rememberedAccountsCookieHeader(kept);
  } catch {
    return rememberedAccountsCookieHeader(withoutActive);
  }
}

/** What the chooser renders per account. `sid` is a stable public identifier
 *  (token-hash prefix) the form posts back — the raw token never appears in
 *  markup. */
export type RememberedAccount = {
  sid: string;
  email: string | null;
  storeName: string;
  storeDomain: string | null;
};

export function sidForToken(raw: string): string {
  return hashSessionToken(raw).slice(0, 16);
}

type SessionRow = {
  token_hash: string;
  user_id: string | null;
  shop_id: string;
  shop_domain: string | null;
  expires_at: string;
  revoked_at: string | null;
  user: { email?: string | null } | null;
  shop: { display_name?: string | null; shop_domain?: string | null } | null;
};

async function fetchRows(tokens: string[]): Promise<Map<string, SessionRow>> {
  if (tokens.length === 0) return new Map();
  const hashes = tokens.map((t) => hashSessionToken(t));
  const { data, error } = await getSupabase()
    .from("dashboard_sessions")
    .select(
      "token_hash, user_id, shop_id, shop_domain, expires_at, revoked_at, user:users(email), shop:shops(display_name, shop_domain)",
    )
    .in("token_hash", hashes);
  if (error) throw error;
  const map = new Map<string, SessionRow>();
  for (const row of (data ?? []) as unknown as SessionRow[]) map.set(row.token_hash, row);
  return map;
}

function rowIsLive(row: SessionRow): boolean {
  if (row.revoked_at) return false;
  return new Date(row.expires_at).getTime() > Date.now();
}

function accountFromRow(raw: string, row: SessionRow): RememberedAccount {
  const domain = row.shop?.shop_domain ?? row.shop_domain ?? null;
  return {
    sid: sidForToken(raw),
    email: row.user?.email ?? null,
    storeName: row.shop?.display_name || domain || "Your store",
    storeDomain: domain,
  };
}

export type ResolvedAccounts = {
  accounts: RememberedAccount[];
  /** Rewrite header when the prune changed the stored set; null when unchanged. */
  cookieHeader: string | null;
};

/** Resolve the cookie's tokens to displayable accounts: dead sessions and
 *  duplicate identities (same user, or same shop for shop-only sessions) are
 *  pruned, newest-first order preserved, capped at MAX_ACCOUNTS. */
export async function resolveRememberedAccounts(request: Request): Promise<ResolvedAccounts> {
  const tokens = readRememberedTokens(request);
  if (tokens.length === 0) return { accounts: [], cookieHeader: null };

  const rows = await fetchRows(tokens);
  const accounts: RememberedAccount[] = [];
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    if (accounts.length >= MAX_ACCOUNTS) break;
    const row = rows.get(hashSessionToken(raw));
    if (!row || !rowIsLive(row)) continue;
    const identity = row.user_id ? `u:${row.user_id}` : `s:${row.shop_id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    kept.push(raw);
    accounts.push(accountFromRow(raw, row));
  }

  const cookieHeader =
    kept.join("|") === tokens.join("|") ? null : rememberedAccountsCookieHeader(kept);
  return { accounts, cookieHeader };
}

export type SwitchResult =
  | { ok: true; raw: string; cookieHeader: null }
  | {
      ok: false;
      /** Prefill for the password fallback when the picked session died. */
      email: string | null;
      /** Rewrite dropping the dead/unknown entry. */
      cookieHeader: string;
    };

/** Look up the chooser selection. The raw token comes from the HttpOnly
 *  cookie, never from the form — the posted `sid` only picks which entry. */
export async function activateRememberedAccount(
  request: Request,
  sid: string,
): Promise<SwitchResult | null> {
  const tokens = readRememberedTokens(request);
  const raw = tokens.find((t) => sidForToken(t) === sid);
  if (!raw) return null;

  const rows = await fetchRows([raw]);
  const row = rows.get(hashSessionToken(raw));
  if (row && rowIsLive(row)) return { ok: true, raw, cookieHeader: null };

  return {
    ok: false,
    email: row?.user?.email ?? null,
    cookieHeader: rememberedAccountsCookieHeader(tokens.filter((t) => t !== raw)),
  };
}

/** Forget one chooser entry: revoke its session server-side (the token must
 *  die, not just disappear from this device) and rewrite the cookie without
 *  it. Unknown sid is a no-op. */
export async function forgetRememberedAccount(
  request: Request,
  sid: string,
): Promise<string | null> {
  const tokens = readRememberedTokens(request);
  const raw = tokens.find((t) => sidForToken(t) === sid);
  if (!raw) return null;
  const { error } = await getSupabase()
    .from("dashboard_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", hashSessionToken(raw))
    .is("revoked_at", null);
  if (error) throw error;
  return rememberedAccountsCookieHeader(tokens.filter((t) => t !== raw));
}
