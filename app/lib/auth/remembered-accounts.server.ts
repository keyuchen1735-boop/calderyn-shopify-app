// app/lib/auth/remembered-accounts.server.ts
//
// The multi-account chooser on /login. The browser keeps the raw session
// tokens of accounts previously signed in on this device in one HttpOnly
// __Host- cookie; the server resolves them at render time. A LIVE session
// renders as a one-click entry; a signed-out one (revoked/expired row) stays
// listed — Shopify-picker style — but only prefills the email for a password
// sign-in. Entries whose session row no longer exists are pruned. Nothing but
// opaque tokens ever sits in the cookie — display data is looked up fresh so
// it can't go stale or leak into script-readable storage. Trust model matches
// Shopify/Google account pickers: possession of the device grants one-click
// entry to each account until its server-side session expires (30 days) or is
// revoked; after that the entry is a labelled shortcut, not an entry ticket.

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

function identityOf(row: SessionRow): string {
  return row.user_id ? `u:${row.user_id}` : `s:${row.shop_id}`;
}

/** Set-Cookie for logout. The signed-out account STAYS listed (its session is
 *  revoked by the logout action, so the chooser downgrades it to an email-
 *  prefill entry), but any OLDER token of the same identity is dropped — a
 *  stale still-live session from an earlier sign-in must not survive an
 *  explicit logout as a one-click entry. Falls back to keeping the list as-is
 *  if the identity lookup fails: logout must never 500 over a prune. */
export async function rememberOnSignOut(
  request: Request,
  activeRaw: string | null,
): Promise<string> {
  const tokens = readRememberedTokens(request);
  if (!activeRaw || !tokens.includes(activeRaw)) {
    return rememberedAccountsCookieHeader(tokens);
  }
  try {
    const rows = await fetchRows(tokens);
    const active = rows.get(hashSessionToken(activeRaw));
    if (!active) return rememberedAccountsCookieHeader(tokens);
    const identity = identityOf(active);
    const kept = tokens.filter((t) => {
      if (t === activeRaw) return true;
      const row = rows.get(hashSessionToken(t));
      if (!row) return true; // unknown → let the next /login resolve decide
      return identityOf(row) !== identity;
    });
    return rememberedAccountsCookieHeader(kept);
  } catch {
    return rememberedAccountsCookieHeader(tokens);
  }
}

/** What the chooser renders per account. `sid` is a stable public identifier
 *  (token-hash prefix) the form posts back — the raw token never appears in
 *  markup. `live: false` means the session ended (signed out / expired): the
 *  entry is only an email-prefill shortcut, never a one-click sign-in. */
export type RememberedAccount = {
  sid: string;
  email: string | null;
  storeName: string;
  storeDomain: string | null;
  live: boolean;
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
    live: rowIsLive(row),
  };
}

export type ResolvedAccounts = {
  accounts: RememberedAccount[];
  /** Rewrite header when the prune changed the stored set; null when unchanged. */
  cookieHeader: string | null;
};

/** Resolve the cookie's tokens to displayable accounts. One entry per
 *  identity (user, or shop for shop-only sessions): a live token beats a dead
 *  one, otherwise the newest wins. Tokens with no session row are pruned;
 *  signed-out entries are kept and marked live: false. Newest-first order
 *  preserved, capped at MAX_ACCOUNTS. */
export async function resolveRememberedAccounts(request: Request): Promise<ResolvedAccounts> {
  const tokens = readRememberedTokens(request);
  if (tokens.length === 0) return { accounts: [], cookieHeader: null };

  const rows = await fetchRows(tokens);

  // Pick the representative token per identity: live > dead, then newest
  // (tokens are stored newest-first, so the first candidate wins ties).
  const bestByIdentity = new Map<string, string>();
  for (const raw of tokens) {
    const row = rows.get(hashSessionToken(raw));
    if (!row) continue;
    const id = identityOf(row);
    const current = bestByIdentity.get(id);
    if (!current) {
      bestByIdentity.set(id, raw);
      continue;
    }
    const currentRow = rows.get(hashSessionToken(current)) as SessionRow;
    if (!rowIsLive(currentRow) && rowIsLive(row)) bestByIdentity.set(id, raw);
  }

  const chosen = new Set(bestByIdentity.values());
  const accounts: RememberedAccount[] = [];
  const kept: string[] = [];
  for (const raw of tokens) {
    if (accounts.length >= MAX_ACCOUNTS) break;
    if (!chosen.has(raw)) continue;
    const row = rows.get(hashSessionToken(raw)) as SessionRow;
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
      /** Prefill for the password fallback when the picked session is dead. */
      email: string | null;
      /** Rewrite header only when the entry vanished entirely (no session
       *  row); a merely signed-out entry stays listed. */
      cookieHeader: string | null;
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
  if (!row) {
    return {
      ok: false,
      email: null,
      cookieHeader: rememberedAccountsCookieHeader(tokens.filter((t) => t !== raw)),
    };
  }
  return { ok: false, email: row.user?.email ?? null, cookieHeader: null };
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
