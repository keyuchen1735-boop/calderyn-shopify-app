// TikTok Business (Marketing API) OAuth.
//
// Mirrors app/lib/meta/oauth.server.ts and app/lib/google/oauth.server.ts: pure
// helpers with an injected fetcher so URL building and token-exchange parsing
// are unit-testable without network.
//
// TikTok's flow differs from Meta/Google: the authorize URL uses `app_id` +
// `redirect_uri` + `state`, and the token endpoint is a JSON POST (not form
// urlencoded) to the Business API, returning the token inside a `data` envelope
// alongside a top-level numeric `code` (0 = success).

const AUTH_ENDPOINT = "https://business-api.tiktok.com/portal/auth";
const TOKEN_ENDPOINT =
  "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/";

export function buildAuthUrl(opts: {
  appId: string;
  redirectUri: string;
  state: string;
}): string {
  const p = new URLSearchParams({
    app_id: opts.appId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

// The token response is wrapped: { code, message, data: {...} }. `code === 0`
// means success; any other code is an error carrying `message`.
export type TikTokTokenResponse = {
  code?: number;
  message?: string;
  data?: {
    access_token?: string;
    refresh_token?: string;
    advertiser_ids?: string[];
    scope?: string[] | string;
    expires_in?: number;
  };
};

// Injected so tests supply fakes; the real caller POSTs JSON to the token
// endpoint. This module owns parsing/validation only.
export type TokenFetcher = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<TikTokTokenResponse>;

export async function exchangeCodeForToken(
  fetcher: TokenFetcher,
  opts: { appId: string; appSecret: string; code: string },
): Promise<{ accessToken: string; advertiserId: string | null; expiresInSec: number }> {
  const res = await fetcher(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: opts.appId,
      secret: opts.appSecret,
      auth_code: opts.code,
      grant_type: "authorization_code",
    }),
  });

  if (res.code !== 0) {
    throw new Error(`TikTok OAuth error: ${res.message ?? `code ${res.code}`}`);
  }
  const token = res.data?.access_token;
  if (!token) {
    throw new Error("TikTok OAuth returned no access_token");
  }

  return {
    accessToken: token,
    advertiserId: res.data?.advertiser_ids?.[0] ?? null,
    expiresInSec: res.data?.expires_in ?? 0,
  };
}
