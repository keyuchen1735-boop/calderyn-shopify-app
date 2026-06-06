// Google Ads OAuth 2.0 (authorization-code grant).
//
// Mirrors app/lib/meta/oauth.server.ts: pure helpers with an injected fetcher
// so URL building and token-exchange parsing are unit-testable without network.
//
// The connect flow asks Google for OFFLINE access so the token endpoint returns
// a long-lived `refresh_token`. We persist ONLY that refresh token (encrypted);
// googleClientForShop exchanges it for short-lived access tokens at call time.
// `access_type=offline` + `prompt=consent` together guarantee a refresh_token is
// issued even on re-consent (Google omits it on silent re-auth otherwise).

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// Least privilege: the Google Ads API scope only. No profile/email scopes.
const SCOPE = "https://www.googleapis.com/auth/adwords";

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const p = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: SCOPE,
    state: opts.state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

export type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

// Injected so tests can supply fakes; the real caller POSTs to the token
// endpoint. The fetcher owns the HTTP; this module owns the parsing/validation.
export type TokenFetcher = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<GoogleTokenResponse>;

export async function exchangeCodeForToken(
  fetcher: TokenFetcher,
  opts: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
  },
): Promise<{ refreshToken: string; accessToken: string; expiresInSec: number }> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    code: opts.code,
    grant_type: "authorization_code",
  }).toString();

  const res = await fetcher(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (res.error || !res.access_token) {
    throw new Error(
      `Google OAuth error: ${res.error_description ?? res.error ?? "no access_token returned"}`,
    );
  }
  if (!res.refresh_token) {
    // A missing refresh_token means re-consent was silent (Google only returns
    // it on the first consent unless prompt=consent forces it). Fail loudly —
    // storing an access-token-only credential would break the refresh flow.
    throw new Error(
      "Google OAuth returned no refresh_token; re-consent with access_type=offline & prompt=consent",
    );
  }

  return {
    refreshToken: res.refresh_token,
    accessToken: res.access_token,
    expiresInSec: res.expires_in ?? 0,
  };
}
