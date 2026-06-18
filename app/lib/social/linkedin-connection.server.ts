// app/lib/social/linkedin-connection.server.ts
//
// LinkedIn OAuth connection store.
// Persists tokens in `linkedin_connection` (one row per member_urn, upsert).
// getValidConnection handles transparent token refresh.
// signState / verifyState produce HMAC-SHA256 states for the OAuth flow.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { refreshAccessToken, type LinkedInTokens } from "~/lib/social/linkedin.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveConnection {
  accessToken: string;
  memberUrn: string;
}

// ---------------------------------------------------------------------------
// saveConnection
// ---------------------------------------------------------------------------

export async function saveConnection(o: {
  tokens: LinkedInTokens;
  memberUrn: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + o.tokens.expiresInSec * 1000).toISOString();

  // Build the upsert payload; only include optional fields when present.
  const payload: Record<string, string | undefined> = {
    member_urn: o.memberUrn,
    access_token: o.tokens.accessToken,
    expires_at: expiresAt,
    updated_at: now,
  };

  if (o.tokens.refreshToken !== undefined) {
    payload.refresh_token = o.tokens.refreshToken;
  }
  if (o.tokens.refreshExpiresInSec !== undefined) {
    payload.refresh_expires_at = new Date(
      Date.now() + o.tokens.refreshExpiresInSec * 1000,
    ).toISOString();
  }
  if (o.tokens.scope !== undefined) {
    payload.scope = o.tokens.scope;
  }

  const { error } = await getSupabase()
    .from("linkedin_connection")
    .upsert(payload, { onConflict: "member_urn" })
    .select();

  if (error) {
    throw new Error(`saveConnection: DB error — ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Row type-guard helpers — no `any`
// ---------------------------------------------------------------------------

interface ConnectionRow {
  member_urn: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
  refresh_expires_at: string | null;
}

function isConnectionRow(row: unknown): row is ConnectionRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.member_urn === "string" &&
    typeof r.access_token === "string" &&
    typeof r.expires_at === "string" &&
    (r.refresh_token === null || typeof r.refresh_token === "string") &&
    (r.refresh_expires_at === null || typeof r.refresh_expires_at === "string")
  );
}

// ---------------------------------------------------------------------------
// getValidConnection
// ---------------------------------------------------------------------------

export async function getValidConnection(): Promise<ActiveConnection | null> {
  const { data, error } = await getSupabase()
    .from("linkedin_connection")
    .select("member_urn, access_token, refresh_token, expires_at, refresh_expires_at")
    .order("connected_at", { ascending: false })
    .limit(1)
    .single();

  // No row found (PGRST116) or other DB error — treat both as "not connected"
  if (error || data === null) return null;

  if (!isConnectionRow(data)) {
    // Malformed row — log but don't crash (rule 12)
    console.error("[linkedin-connection] malformed row from DB, skipping:", data);
    return null;
  }

  const expiresAt = new Date(data.expires_at).getTime();
  const nowMs = Date.now();
  const bufferMs = 60 * 1000; // 60s buffer

  if (expiresAt > nowMs + bufferMs) {
    // Token is still valid
    return { accessToken: data.access_token, memberUrn: data.member_urn };
  }

  // Token is expired (or within the 60s buffer)
  if (
    data.refresh_token &&
    process.env.LINKEDIN_CLIENT_ID &&
    process.env.LINKEDIN_CLIENT_SECRET
  ) {
    try {
      const newTokens = await refreshAccessToken({
        refreshToken: data.refresh_token,
        clientId: process.env.LINKEDIN_CLIENT_ID,
        clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
      });
      await saveConnection({ tokens: newTokens, memberUrn: data.member_urn });
      return { accessToken: newTokens.accessToken, memberUrn: data.member_urn };
    } catch (err) {
      // Surface the failure visibly without crashing (rule 12)
      console.error("[linkedin-connection] token refresh failed:", err);
      return null;
    }
  }

  // Expired, no refresh token or missing env creds
  return null;
}

// ---------------------------------------------------------------------------
// signState / verifyState — HMAC-SHA256, ~10min expiry
// ---------------------------------------------------------------------------

const STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

function getStateSecret(): string {
  const s = process.env.SOCIAL_ACTION_SECRET ?? process.env.CRON_SECRET;
  if (!s) throw new Error("signState: SOCIAL_ACTION_SECRET or CRON_SECRET must be set");
  return s;
}

/** Returns a signed state string: `<nonce>:<exp>.<hmac>` */
export function signState(): string {
  const nonce = randomBytes(16).toString("hex");
  const exp = (Date.now() + STATE_EXPIRY_MS).toString(10);
  const payload = `${nonce}:${exp}`;
  const sig = createHmac("sha256", getStateSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

/** Returns true iff the state was signed by us and has not expired. */
export function verifyState(s: string): boolean {
  if (!s) return false;
  const dotIdx = s.lastIndexOf(".");
  if (dotIdx === -1) return false;

  const payload = s.slice(0, dotIdx);
  const sig = s.slice(dotIdx + 1);

  // Validate payload shape: `<nonce>:<exp>`
  const colonIdx = payload.indexOf(":");
  if (colonIdx === -1) return false;
  const expStr = payload.slice(colonIdx + 1);
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return false;

  // Check expiry before HMAC (fast path for obviously-stale states)
  if (Date.now() > exp) return false;

  // Constant-time HMAC comparison
  let secret: string;
  try {
    secret = getStateSecret();
  } catch {
    return false;
  }
  const expected = createHmac("sha256", secret).update(payload).digest("hex");

  try {
    return timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}
