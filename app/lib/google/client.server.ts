// fetch-based Google Ads client.
//
// Mirrors MetaClient's shape (an object behind an interface so it can be faked
// in unit tests). The real client (a) exchanges the shop's refresh token for a
// short-lived access token, then (b) streams GAQL results from the Google Ads
// REST endpoint.

import { getSupabase } from "../supabase.server";
import { decrypt } from "../crypto.server";

const GOOGLE_ADS_API_VERSION = "v23";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ADS_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

/** Testable surface: runs a GAQL query and returns the flattened result rows. */
export type GoogleAdsClient = {
  search(gaql: string): Promise<unknown[]>;
};

export type GoogleConnection = { client: GoogleAdsClient; customerId: string };

type CredentialRow = {
  access_token_encrypted: string | null;
  external_account_id: string | null;
};

type GoogleTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

async function exchangeRefreshToken(refreshToken: string): Promise<string> {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET must be set");
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as GoogleTokenResponse;
  if (json.error || !json.access_token) {
    // Surface the OAuth error CODE (e.g. invalid_grant) alongside the human
    // description: a dead refresh token reports `invalid_grant`, which
    // isReauthError keys off to flag the integration for reconnect (vs a
    // transient/config failure we just record as a generic error).
    throw new Error(
      `Google OAuth token exchange failed (${json.error ?? "unknown"}): ${json.error_description ?? json.error ?? "no access_token"}`,
    );
  }
  return json.access_token;
}

// Loose shape of the searchStream response: an array of batches, each holding a
// `results` array. This is the documented raw-API-payload exception to no-`any`
// (precise optionals, never `any`).
type AdsErrorDetail = {
  errors?: Array<{ errorCode?: Record<string, string>; message?: string }>;
};
type SearchStreamBatch = { results?: unknown[]; error?: { message?: string } };
type SearchStreamError = { error?: { message?: string; details?: AdsErrorDetail[] } };

/**
 * Extract a human message from a Google Ads error body. The streaming endpoint
 * returns errors EITHER as a bare `{ error: {...} }` OR — because it is a stream
 * — as a single-element array `[{ error: {...} }]`. Handle both.
 *
 * The top-level `error.message` is generic (every PERMISSION_DENIED says "The
 * caller does not have permission"); the actionable reason — e.g.
 * DEVELOPER_TOKEN_NOT_APPROVED — lives in `error.details[].errors[]`. Append it
 * so shop_integrations.sync_error is diagnosable (rule 12).
 */
export function extractAdsError(body: unknown): string | null {
  const obj = Array.isArray(body) ? body[0] : body;
  const err = (obj as SearchStreamError | undefined)?.error;
  if (!err) return null;
  const top = err.message ?? "Google Ads API error";
  const detail = (err.details ?? [])
    .flatMap((d) => d.errors ?? [])
    .map((e) =>
      [e.errorCode ? Object.values(e.errorCode).join("/") : null, e.message]
        .filter(Boolean)
        .join(": "),
    )
    .filter(Boolean)
    .join("; ");
  return detail ? `${top} — ${detail}` : top;
}

/**
 * True when a sync failure means the merchant's stored Google credential is dead
 * and they must re-authorize — vs a transient API/network error or a config
 * problem (e.g. an unapproved developer token) that reconnecting wouldn't fix.
 *
 * The canonical signal is the OAuth `invalid_grant` code Google returns when a
 * refresh token is expired or revoked (see exchangeRefreshToken, which now
 * includes that code in the thrown message). We also match the human-readable
 * "expired or revoked" form as a belt-and-suspenders fallback. Deliberately
 * narrow: DEVELOPER_TOKEN_NOT_APPROVED / PERMISSION_DENIED are NOT reauth.
 *
 * Mirrors quickbooks/oauth.server.ts:isRevokedTokenError (same invalid_grant
 * signal). The "reauth" status these feed is generic, but QuickBooks still maps
 * a revoked token to "disconnected" — a follow-up can fold both onto one shared
 * classifier and have every provider adopt "reauth".
 */
export function isReauthError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("invalid_grant") || m.includes("expired or revoked");
}

/**
 * Parse a raw searchStream response body into flattened result rows, failing
 * visibly (rule 12) on every error shape. Read the body as TEXT first: a sunset
 * or invalid API version returns an HTML 404, and calling res.json() on that
 * throws an opaque `Unexpected token '<', "<!DOCTYPE "...` SyntaxError that gets
 * persisted to shop_integrations.sync_error. Surface the real HTTP status + body
 * instead. Exported for unit testing without network.
 */
export function parseSearchStreamResponse(
  raw: string,
  ok: boolean,
  status: number,
): unknown[] {
  let json: SearchStreamBatch[] | SearchStreamError;
  try {
    json = JSON.parse(raw) as SearchStreamBatch[] | SearchStreamError;
  } catch {
    throw new Error(
      `Google Ads API error: non-JSON response (HTTP ${status}): ${raw.slice(0, 200)}`,
    );
  }

  // A non-2xx status, or an error-shaped body (including the array-wrapped
  // `[{error}]` streaming form), must throw — never be parsed as zero results
  // and recorded as a clean, empty sync.
  const errMessage = extractAdsError(json);
  if (!ok || errMessage) {
    throw new Error(`Google Ads API error: ${errMessage ?? `HTTP ${status}`}`);
  }
  if (!Array.isArray(json)) {
    throw new Error(`Google Ads API error: unexpected non-array response (HTTP ${status})`);
  }

  const rows: unknown[] = [];
  for (const batch of json) {
    for (const r of batch.results ?? []) rows.push(r);
  }
  return rows;
}

function buildClient(customerId: string, refreshToken: string): GoogleAdsClient {
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) {
    throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN must be set");
  }
  // Exchange the refresh token for an access token ONCE per connection and
  // reuse it across this client's queries (a cron tick lives well inside the
  // token's lifetime). Memoize the promise so concurrent/sequential search()
  // calls share a single token round-trip instead of one exchange per query.
  let tokenPromise: Promise<string> | null = null;
  const accessToken = (): Promise<string> =>
    (tokenPromise ??= exchangeRefreshToken(refreshToken));

  return {
    async search(gaql: string): Promise<unknown[]> {
      const res = await fetch(`${ADS_BASE}/customers/${customerId}/googleAds:searchStream`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          "developer-token": developerToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: gaql }),
      });
      const raw = await res.text();
      return parseSearchStreamResponse(raw, res.ok, res.status);
    },
  };
}

/**
 * Load the shop's google_ads credentials and build a client. Returns null when
 * there is no credential row (nothing to do), or when the row lacks a refresh
 * token / customer id. Throws (via decrypt) if a stored token is malformed —
 * never returns a fake token.
 *
 * The refresh token is stored ENCRYPTED in integration_credentials by the
 * Google OAuth callback (app/routes/auth.google.$.tsx), using the same
 * crypto.server text format Meta uses (closing the former `bytea` decryption
 * gap on shop_integrations.refresh_token_enc).
 */
export async function googleClientForShop(shopId: string): Promise<GoogleConnection | null> {
  const { data, error } = await getSupabase()
    .from("integration_credentials")
    .select("access_token_encrypted, external_account_id")
    .eq("shop_id", shopId)
    .eq("kind", "google_ads")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as CredentialRow;
  if (!row.access_token_encrypted || !row.external_account_id) return null;

  const refreshToken = decrypt(row.access_token_encrypted);
  return { client: buildClient(row.external_account_id, refreshToken), customerId: row.external_account_id };
}
