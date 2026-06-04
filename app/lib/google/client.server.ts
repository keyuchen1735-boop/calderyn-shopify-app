// fetch-based Google Ads client.
//
// Mirrors MetaClient's shape (an object behind an interface so it can be faked
// in unit tests). The real client (a) exchanges the shop's refresh token for a
// short-lived access token, then (b) streams GAQL results from the Google Ads
// REST endpoint.

import { getSupabase } from "../supabase.server";

const GOOGLE_ADS_API_VERSION = "v17";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ADS_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

/** Testable surface: runs a GAQL query and returns the flattened result rows. */
export type GoogleAdsClient = {
  search(gaql: string): Promise<unknown[]>;
};

export type GoogleConnection = { client: GoogleAdsClient; customerId: string };

type IntegrationRow = {
  refresh_token_enc: string | null;
  external_account_id: string | null;
};

/**
 * Decrypt the shop's stored Google refresh token.
 *
 * KNOWN GAP (rule 12 — fail visibly): `shop_integrations.refresh_token_enc` is
 * `bytea`. In the monorepo this was decrypted DB-side. This repo's
 * crypto.server.ts uses an incompatible text format (`ivHex:tagHex:dataHex`),
 * and there is NO Google OAuth route yet — so in practice no `google_ads`
 * integration rows exist. We therefore have no token to decrypt and no scheme
 * that round-trips against `bytea`.
 *
 * Rather than fabricate an empty/fake token (which would silently produce
 * unauthenticated API calls), this throws a clear error. The cron caller
 * catches it per-shop and records it in the error summary.
 *
 * FOLLOW-UP: wire a Google OAuth callback that persists the refresh token using
 * an encryption scheme compatible with the `bytea` column, then implement real
 * decryption here.
 */
function decryptRefreshToken(_enc: string): string {
  throw new Error(
    "Google refresh-token decryption is not implemented: shop_integrations.refresh_token_enc " +
      "is bytea and no bytea-compatible encryption scheme / Google OAuth route exists yet. " +
      "This is a documented follow-up; see decryptRefreshToken in app/lib/google/client.server.ts.",
  );
}

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
    throw new Error(`Google OAuth token exchange failed: ${json.error_description ?? json.error ?? "no access_token"}`);
  }
  return json.access_token;
}

// Loose shape of the searchStream response: an array of batches, each holding a
// `results` array. This is the documented raw-API-payload exception to no-`any`
// (precise optionals, never `any`).
type SearchStreamBatch = { results?: unknown[]; error?: { message?: string } };
type SearchStreamError = { error?: { message?: string } };

/**
 * Extract a human message from a Google Ads error body. The streaming endpoint
 * returns errors EITHER as a bare `{ error: {...} }` OR — because it is a stream
 * — as a single-element array `[{ error: {...} }]`. Handle both.
 */
export function extractAdsError(body: unknown): string | null {
  const obj = Array.isArray(body) ? body[0] : body;
  const err = (obj as SearchStreamError | undefined)?.error;
  return err ? (err.message ?? "Google Ads API error") : null;
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
      const json = (await res.json()) as SearchStreamBatch[] | SearchStreamError;

      // Fail visibly (rule 12). A non-2xx status, or an error-shaped body
      // (including the array-wrapped `[{error}]` streaming form), must throw —
      // never be parsed as zero results and recorded as a clean, empty sync.
      const errMessage = extractAdsError(json);
      if (!res.ok || errMessage) {
        throw new Error(
          `Google Ads API error: ${errMessage ?? `HTTP ${res.status}`}`,
        );
      }
      if (!Array.isArray(json)) {
        throw new Error(`Google Ads API error: unexpected non-array response (HTTP ${res.status})`);
      }

      const rows: unknown[] = [];
      for (const batch of json) {
        for (const r of batch.results ?? []) rows.push(r);
      }
      return rows;
    },
  };
}

/**
 * Load the shop's google_ads integration and build a client. Returns null when
 * there is no integration row (nothing to do), or when the row lacks a refresh
 * token / customer id. Throws (via decryptRefreshToken) when a token exists but
 * cannot be decrypted — never returns a fake token.
 */
export async function googleClientForShop(shopId: string): Promise<GoogleConnection | null> {
  const { data, error } = await getSupabase()
    .from("shop_integrations")
    .select("refresh_token_enc, external_account_id")
    .eq("shop_id", shopId)
    .eq("kind", "google_ads")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as IntegrationRow;
  if (!row.refresh_token_enc || !row.external_account_id) return null;

  const refreshToken = decryptRefreshToken(row.refresh_token_enc);
  return { client: buildClient(row.external_account_id, refreshToken), customerId: row.external_account_id };
}
