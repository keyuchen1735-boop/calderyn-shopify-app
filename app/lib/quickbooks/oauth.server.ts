// QuickBooks Online OAuth 2.0 (authorization-code grant).
//
// Mirrors app/lib/google/oauth.server.ts: pure helpers with an injected fetcher
// so URL building and token parsing are unit-testable without network.
//
// QBO access tokens are short-lived (~1h). The refresh token (~100d) ROTATES on
// every exchange — callers MUST persist the returned refresh_token each time, or
// the next refresh fails. See app/lib/quickbooks/client.server.ts.

const AUTH_ENDPOINT = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting";

export function buildAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const p = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: SCOPE,
    state: opts.state,
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

export type QboTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  x_refresh_token_expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

// Injected so tests supply fakes; the real caller POSTs to the token endpoint.
export type TokenFetcher = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<QboTokenResponse>;

export type ParsedTokens = {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  refreshExpiresInSec: number;
};

function basicAuth(clientId: string, clientSecret: string): string {
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

function parseTokens(res: QboTokenResponse): ParsedTokens {
  if (res.error || !res.access_token) {
    throw new Error(
      `QuickBooks OAuth error: ${res.error_description ?? res.error ?? "no access_token returned"}`,
    );
  }
  if (!res.refresh_token) {
    throw new Error("QuickBooks OAuth returned no refresh_token");
  }
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresInSec: res.expires_in ?? 0,
    refreshExpiresInSec: res.x_refresh_token_expires_in ?? 0,
  };
}

async function postToken(
  fetcher: TokenFetcher,
  clientId: string,
  clientSecret: string,
  body: string,
): Promise<ParsedTokens> {
  const res = await fetcher(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(clientId, clientSecret),
    },
    body,
  });
  return parseTokens(res);
}

export async function exchangeCodeForToken(
  fetcher: TokenFetcher,
  opts: { clientId: string; clientSecret: string; redirectUri: string; code: string },
): Promise<ParsedTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
  }).toString();
  return postToken(fetcher, opts.clientId, opts.clientSecret, body);
}

export async function refreshAccessToken(
  fetcher: TokenFetcher,
  opts: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<ParsedTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
  }).toString();
  return postToken(fetcher, opts.clientId, opts.clientSecret, body);
}
