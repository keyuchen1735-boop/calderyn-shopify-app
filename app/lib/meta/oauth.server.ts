const GRAPH_VERSION = "v21.0";
const SCOPE = "ads_management,ads_read";

export function buildAuthUrl(opts: { appId: string; redirectUri: string; state: string }): string {
  const p = new URLSearchParams({
    client_id: opts.appId,
    redirect_uri: opts.redirectUri,
    scope: SCOPE,
    state: opts.state,
    response_type: "code",
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${p.toString()}`;
}

export type GraphTokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: { message: string; code?: number };
};
export type TokenFetcher = (url: string) => Promise<GraphTokenResponse>;

function checkToken(r: GraphTokenResponse): GraphTokenResponse {
  if (r.error) throw new Error(`Meta OAuth error: ${r.error.message}`);
  if (!r.access_token) throw new Error("Meta OAuth returned no access_token");
  return r;
}

export async function exchangeCodeForToken(
  fetcher: TokenFetcher,
  opts: { appId: string; appSecret: string; redirectUri: string; code: string },
): Promise<{ accessToken: string; expiresInSec: number }> {
  const base = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`;
  const shortUrl =
    `${base}?client_id=${encodeURIComponent(opts.appId)}` +
    `&redirect_uri=${encodeURIComponent(opts.redirectUri)}` +
    `&client_secret=${encodeURIComponent(opts.appSecret)}` +
    `&code=${encodeURIComponent(opts.code)}`;
  const short = checkToken(await fetcher(shortUrl));

  const longUrl =
    `${base}?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(opts.appId)}` +
    `&client_secret=${encodeURIComponent(opts.appSecret)}` +
    `&fb_exchange_token=${encodeURIComponent(short.access_token!)}`;
  const long = checkToken(await fetcher(longUrl));

  return { accessToken: long.access_token!, expiresInSec: long.expires_in ?? 0 };
}
