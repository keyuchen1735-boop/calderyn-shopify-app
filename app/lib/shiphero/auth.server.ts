// ShipHero token refresh (credential/refresh model — NOT OAuth). Plan 03 Part B, corrected.
//
// ShipHero is credential/token-based, not OAuth: the merchant creates a "3rd Party
// Developer" user in their ShipHero account (My Account → Developer Users) and is issued
// an Access Token (expires in 28 days) + a long-lived Refresh Token. There is NO
// authorize-redirect and NO app-level client_id/secret. The merchant pastes their REFRESH
// token; the cost adapter mints a fresh access token from it each run via /auth/refresh
// (daily cron + 28-day access tokens → re-minting per run is correct and simplest, so no
// access-token caching). GraphQL auth is then `Authorization: Bearer <access_token>`.
//
// Mirrors app/lib/shippo/oauth.server.ts: a pure helper with an injected fetcher so URL
// building + token parsing are unit-testable without network. Built-in fetch, no new dep.
//
// ⚠️ LIVE-VERIFICATION TODO (a): the exact /auth/refresh response field names + casing
// (`access_token` / `expires_in`) are taken from developer.shiphero.com + KB/community and
// are NOT yet confirmed against a live self-serve dev-user token. If ShipHero returns a
// differently-cased/named field, this parse must be adjusted (and a fixture added).
// ⚠️ LIVE-VERIFICATION TODO (e): ToS — we collect ONLY the ShipHero-ISSUED refresh token
// (created for a dedicated 3rd-Party Developer user), never the merchant's raw ShipHero
// login credentials.

const DEFAULT_BASE = "https://public-api.shiphero.com";

/**
 * Resolve the auth base (host for /auth/refresh). Reads SHIPHERO_API_BASE for env parity
 * with the cost adapter — but that var conventionally points at the GraphQL endpoint
 * (".../graphql"), whereas /auth/refresh lives at the API ROOT, so a trailing "/graphql"
 * segment is stripped here. Tolerates either the bare host or the GraphQL URL.
 */
function authBase(): string {
  const raw = process.env.SHIPHERO_API_BASE?.trim();
  const base = (raw && raw.length > 0 ? raw : DEFAULT_BASE).replace(/\/+$/, "");
  return base.replace(/\/graphql$/, "");
}

interface ShipHeroRefreshResponse {
  access_token?: string;
  expires_in?: number | string | null;
  // Parsed defensively; an error body may carry one of these instead of a token.
  error?: string;
  error_description?: string;
  message?: string;
}

/**
 * Exchange a ShipHero REFRESH token for a fresh ACCESS token via POST {base}/auth/refresh.
 * Pure + injectable fetch (defaults to global fetch). Throws a clear error on any non-2xx
 * or a missing access_token (body sliced to ~200 chars for debugging). NEVER logs the token
 * (the refresh token is long-lived; leaking it is as bad as leaking a password — rule 12).
 */
export async function refreshShipHeroToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresIn: number | null }> {
  const url = `${authBase()}/auth/refresh`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch (err) {
    // Network-level failure (DNS, TLS, timeout). Surface it; do not echo the token.
    throw new Error(`ShipHero token refresh unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`ShipHero token refresh ${res.status} ${res.statusText}: ${snippet}`);
  }
  const json = (await res.json().catch(() => ({}))) as ShipHeroRefreshResponse;
  const accessToken = json.access_token;
  if (!accessToken || typeof accessToken !== "string") {
    const detail = json.error_description ?? json.error ?? json.message ?? "no access_token in response";
    throw new Error(`ShipHero token refresh returned no access_token: ${String(detail).slice(0, 200)}`);
  }
  const rawExp = json.expires_in;
  const expNum = typeof rawExp === "string" ? Number(rawExp) : rawExp;
  const expiresIn = typeof expNum === "number" && Number.isFinite(expNum) ? expNum : null;
  return { accessToken, expiresIn };
}
