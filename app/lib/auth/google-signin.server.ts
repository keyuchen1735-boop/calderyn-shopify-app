// app/lib/auth/google-signin.server.ts
//
// Google sign-in (OpenID Connect). Dedicated client, scope openid+email+profile,
// no offline/refresh (sign-in needs no refresh token). The id_token is validated
// server-side via Google's tokeninfo endpoint so no JWT-verification dependency
// is required. Pure helpers with injected fetchers for testability.

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TOKENINFO_ENDPOINT = "https://oauth2.googleapis.com/tokeninfo";
const SCOPE = "openid email profile";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export function buildSigninAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const p = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: SCOPE,
    state: opts.state,
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

export type IdTokenFetcher = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ id_token?: string; access_token?: string; error?: string; error_description?: string }>;

export async function exchangeCodeForIdToken(
  fetcher: IdTokenFetcher,
  opts: { clientId: string; clientSecret: string; redirectUri: string; code: string },
): Promise<string> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    code: opts.code,
    grant_type: "authorization_code",
  }).toString();
  const res = await fetcher(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (res.error || !res.id_token) {
    throw new Error(`Google sign-in token exchange failed: ${res.error_description ?? res.error ?? "no id_token"}`);
  }
  return res.id_token;
}

export type TokenInfoFetcher = (url: string) => Promise<{
  aud?: string; iss?: string; sub?: string; email?: string; email_verified?: string | boolean; exp?: string | number;
}>;

export async function verifyIdToken(
  fetcher: TokenInfoFetcher,
  idToken: string,
  clientId: string,
): Promise<{ sub: string; email: string; emailVerified: boolean }> {
  const info = await fetcher(`${TOKENINFO_ENDPOINT}?id_token=${encodeURIComponent(idToken)}`);
  if (info.aud !== clientId) throw new Error("google id_token aud mismatch");
  if (!info.iss || !GOOGLE_ISSUERS.includes(info.iss)) throw new Error("google id_token iss invalid");
  const exp = Number(info.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) throw new Error("google id_token expired");
  if (!info.sub || !info.email) throw new Error("google id_token missing sub/email");
  const emailVerified = info.email_verified === true || info.email_verified === "true";
  return { sub: String(info.sub), email: String(info.email), emailVerified };
}
