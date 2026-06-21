// app/lib/social/linkedin-connection.server.ts
//
// LinkedIn OAuth connection store.
// Persists tokens in `linkedin_connection` (one row per member_urn, upsert).
// getValidConnection handles transparent token refresh.
// signState / verifyState produce HMAC-SHA256 states for the OAuth flow.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { encrypt, decrypt } from "~/lib/crypto.server";
import { refreshAccessToken, type LinkedInTokens } from "~/lib/social/linkedin.server";

// Integration tokens are encrypted at rest with crypto.server (aes-256-gcm), the
// same as every other provider. Ciphertext is `ivHex:tagHex:dataHex`. Rows
// written before this change stored the token in plaintext, so decode
// tolerantly: anything not shaped like our ciphertext is returned as-is and is
// re-encrypted on its next saveConnection (e.g. the next token refresh).
const CIPHERTEXT_RE = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i;
function decryptToken(stored: string): string {
  if (!CIPHERTEXT_RE.test(stored)) return stored;
  try {
    return decrypt(stored);
  } catch {
    return stored;
  }
}

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
  ownerEmail?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + o.tokens.expiresInSec * 1000).toISOString();

  // Build the upsert payload; only include optional fields when present.
  const payload: Record<string, string | undefined> = {
    member_urn: o.memberUrn,
    access_token: encrypt(o.tokens.accessToken),
    expires_at: expiresAt,
    updated_at: now,
  };

  if (o.ownerEmail !== undefined) {
    payload.owner_email = o.ownerEmail;
  }
  if (o.tokens.refreshToken !== undefined) {
    payload.refresh_token = encrypt(o.tokens.refreshToken);
  }
  if (o.tokens.refreshExpiresInSec !== undefined) {
    payload.refresh_expires_at = new Date(
      Date.now() + o.tokens.refreshExpiresInSec * 1000,
    ).toISOString();
  }
  if (o.tokens.scope !== undefined) {
    payload.scope = o.tokens.scope;
  }

  // When ownerEmail is provided, upsert on owner_email (one row per founder).
  // Without ownerEmail, keep legacy behavior: upsert on member_urn.
  const onConflict = o.ownerEmail !== undefined ? "owner_email" : "member_urn";

  const { error } = await getSupabase()
    .from("linkedin_connection")
    .upsert(payload, { onConflict })
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
  owner_email: string | null;
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
    return { accessToken: decryptToken(data.access_token), memberUrn: data.member_urn };
  }

  // Token is expired (or within the 60s buffer)
  if (
    data.refresh_token &&
    process.env.LINKEDIN_CLIENT_ID &&
    process.env.LINKEDIN_CLIENT_SECRET
  ) {
    try {
      const newTokens = await refreshAccessToken({
        refreshToken: decryptToken(data.refresh_token),
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
// getValidConnectionFor — lookup by ownerEmail
// ---------------------------------------------------------------------------

export async function getValidConnectionFor(ownerEmail: string): Promise<ActiveConnection | null> {
  const { data, error } = await getSupabase()
    .from("linkedin_connection")
    .select("member_urn, access_token, refresh_token, expires_at, refresh_expires_at, owner_email")
    .eq("owner_email", ownerEmail)
    .limit(1)
    .single();

  // No row found (PGRST116) or other DB error — treat both as "not connected"
  if (error || data === null) return null;

  if (!isConnectionRow(data)) {
    console.error("[linkedin-connection] malformed row from DB for owner, skipping:", data);
    return null;
  }

  const expiresAt = new Date(data.expires_at).getTime();
  const nowMs = Date.now();
  const bufferMs = 60 * 1000; // 60s buffer

  if (expiresAt > nowMs + bufferMs) {
    return { accessToken: decryptToken(data.access_token), memberUrn: data.member_urn };
  }

  // Token is expired (or within the 60s buffer)
  if (
    data.refresh_token &&
    process.env.LINKEDIN_CLIENT_ID &&
    process.env.LINKEDIN_CLIENT_SECRET
  ) {
    try {
      const newTokens = await refreshAccessToken({
        refreshToken: decryptToken(data.refresh_token),
        clientId: process.env.LINKEDIN_CLIENT_ID,
        clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
      });
      await saveConnection({ tokens: newTokens, memberUrn: data.member_urn, ownerEmail });
      return { accessToken: newTokens.accessToken, memberUrn: data.member_urn };
    } catch (err) {
      console.error("[linkedin-connection] token refresh failed for owner:", err);
      return null;
    }
  }

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

/**
 * Returns a signed state string: `<ownerB64>:<nonce>:<exp>.<hmac>`
 * The ownerEmail is base64url-encoded so colons in email addresses don't
 * collide with the colon delimiter.
 */
export function signState(ownerEmail: string): string {
  const ownerB64 = Buffer.from(ownerEmail).toString("base64url");
  const nonce = randomBytes(16).toString("hex");
  const exp = (Date.now() + STATE_EXPIRY_MS).toString(10);
  const payload = `${ownerB64}:${nonce}:${exp}`;
  const sig = createHmac("sha256", getStateSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

/**
 * Returns `{ owner: string }` iff the state was signed by us and has not
 * expired, or `null` on any failure (tampered, expired, bad format).
 */
export function verifyState(s: string): { owner: string } | null {
  if (!s) return null;
  const dotIdx = s.lastIndexOf(".");
  if (dotIdx === -1) return null;

  const payload = s.slice(0, dotIdx);
  const sig = s.slice(dotIdx + 1);

  // Validate payload shape: `<ownerB64>:<nonce>:<exp>`
  // There are exactly 2 colons: split into [ownerB64, nonce, exp]
  const parts = payload.split(":");
  if (parts.length !== 3) return null;
  const [ownerB64, , expStr] = parts;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return null;

  // Check expiry before HMAC (fast path for obviously-stale states)
  if (Date.now() > exp) return null;

  // Constant-time HMAC comparison
  let secret: string;
  try {
    secret = getStateSecret();
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(payload).digest("hex");

  let valid: boolean;
  try {
    valid = timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return null;
  }

  if (!valid) return null;

  const owner = Buffer.from(ownerB64, "base64url").toString("utf8");
  return { owner };
}
