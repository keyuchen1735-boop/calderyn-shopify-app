// Google Search Console connect + credential store (Radar Phase B).
// Least privilege: webmasters.readonly only. The refresh token is encrypted
// into seo_google_credential, a deny-all table only service-role code reads.
import { encrypt, decrypt } from "~/lib/crypto.server";
import { getSupabase } from "~/lib/supabase.server";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function clientId(): string {
  const id = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID || process.env.GOOGLE_ADS_CLIENT_ID;
  if (!id) throw new Error("Google Search Console OAuth client id is not configured");
  return id;
}
function clientSecret(): string {
  const secret =
    process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET || process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!secret) throw new Error("Google Search Console OAuth client secret is not configured");
  return secret;
}

// CSRF state cookie for the connect/callback route pair (dashboard.auth.gsc,
// dashboard.auth.gsc_.callback). Lives here rather than in the route modules
// so both routes can import it without one route module importing another.
export const GSC_STATE_COOKIE = "__Host-gsc_state";

export function gscRedirectUri(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/dashboard/auth/gsc/callback`;
}

export function buildGscAuthUrl(opts: { redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(
  body: URLSearchParams,
  fetcher: typeof fetch,
): Promise<{ access_token: string; refresh_token?: string }> {
  const res = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google token endpoint ${res.status}: ${text}`);
  return JSON.parse(text) as { access_token: string; refresh_token?: string };
}

export async function exchangeGscCode(
  code: string,
  redirectUri: string,
  fetcher: typeof fetch = fetch,
): Promise<{ refreshToken: string | null; accessToken: string }> {
  const out = await tokenRequest(
    new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    fetcher,
  );
  return { refreshToken: out.refresh_token ?? null, accessToken: out.access_token };
}

export async function refreshGscAccessToken(
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const out = await tokenRequest(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: "refresh_token",
    }),
    fetcher,
  );
  return out.access_token;
}

export async function saveGscCredential(shopId: string, refreshToken: string): Promise<void> {
  const { error } = await getSupabase()
    .from("seo_google_credential")
    .upsert(
      { shop_id: shopId, refresh_token_encrypted: encrypt(refreshToken), updated_at: new Date().toISOString() },
      { onConflict: "shop_id" },
    );
  if (error) throw new Error(`saveGscCredential: ${error.message}`);
}

export async function loadGscRefreshToken(shopId: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from("seo_google_credential")
    .select("refresh_token_encrypted")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw new Error(`loadGscRefreshToken: ${error.message}`);
  return data ? decrypt(data.refresh_token_encrypted) : null;
}

const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export async function disconnectGsc(shopId: string, fetcher: typeof fetch = fetch): Promise<void> {
  const refreshToken = await loadGscRefreshToken(shopId);
  if (refreshToken) {
    // Best-effort: Google-side revoke reduces standing grant exposure, but a
    // failure here must never block the local disconnect below.
    try {
      await fetcher(REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.error(`[gsc] revoke failed for shop ${shopId}`, err);
    }
  }
  const sb = getSupabase();
  const del = await sb.from("seo_google_credential").delete().eq("shop_id", shopId);
  if (del.error) throw new Error(`disconnectGsc: ${del.error.message}`);
  const upd = await sb
    .from("seo_settings")
    .update({ gsc_connected: false, gsc_site_url: null })
    .eq("shop_id", shopId);
  if (upd.error) throw new Error(`disconnectGsc settings: ${upd.error.message}`);
}
