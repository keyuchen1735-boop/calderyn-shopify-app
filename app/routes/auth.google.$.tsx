import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  exchangeCodeForToken,
  type GoogleTokenResponse,
} from "~/lib/google/oauth.server";
import { consumeOAuthState } from "~/lib/meta/oauth-state.server";
import { getSupabase } from "~/lib/supabase.server";
import { encrypt } from "~/lib/crypto.server";

// Google Ads OAuth callback. Mirrors app/routes/auth.meta.$.tsx:
//   1. consume the single-use `state` nonce (CSRF + resolves the shop),
//   2. exchange the code for a long-lived refresh token,
//   3. resolve the first accessible Ads customer id,
//   4. upsert the ENCRYPTED refresh token into integration_credentials, and
//   5. upsert shop_integrations with sync_status='pending' so cron.google's
//      backfill picks the shop up on its next tick.
//
// No `authenticate.admin` here — same as auth.meta: the redirect arrives from
// Google's domain without the embedded app session, so the single-use nonce
// (minted under authenticate.admin in startOAuth) is the authenticator.

const ADS_API_VERSION = "v17";

type AccessibleCustomersResponse = {
  resourceNames?: string[]; // e.g. ["customers/1234567890"]
  error?: { message?: string };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const appUrl = process.env.SHOPIFY_APP_URL;

  // Surface a user-declined consent cleanly rather than as a 400.
  if (oauthError) {
    return redirect(`/app/settings?google=error&reason=${encodeURIComponent(oauthError)}`);
  }
  if (!code || !state || !clientId || !clientSecret || !appUrl) {
    throw new Response("Missing OAuth parameters", { status: 400 });
  }

  // Consume the single-use state nonce first: authenticates the callback and
  // resolves the destination shop. Reject before any token exchange.
  const sb = getSupabase();
  const shopId = await consumeOAuthState(sb, state);
  if (!shopId) throw new Response("Invalid or expired OAuth state", { status: 400 });

  const fetcher = async (
    u: string,
    init: { method: "POST"; headers: Record<string, string>; body: string },
  ): Promise<GoogleTokenResponse> =>
    (await fetch(u, init)).json() as Promise<GoogleTokenResponse>;

  const { refreshToken, expiresInSec } = await exchangeCodeForToken(fetcher, {
    clientId,
    clientSecret,
    redirectUri: `${appUrl}/auth/google`,
    code,
  });

  // Resolve the first accessible Ads customer to store as external_account_id.
  // listAccessibleCustomers needs an access token + developer token; if the
  // developer token is absent we still store the credential (customer id stays
  // null), and the cron skips the shop until it can be resolved.
  let customerId: string | null = null;
  if (developerToken) {
    const accessToken = await exchangeRefreshTokenOnce(refreshToken, clientId, clientSecret);
    const res = await fetch(
      `https://googleads.googleapis.com/${ADS_API_VERSION}/customers:listAccessibleCustomers`,
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "developer-token": developerToken,
        },
      },
    );
    const body = (await res.json()) as AccessibleCustomersResponse;
    if (!res.ok || body.error) {
      throw new Response(
        `Google Ads error: ${body.error?.message ?? `HTTP ${res.status}`}`,
        { status: 502 },
      );
    }
    // "customers/1234567890" -> "1234567890"
    const first = body.resourceNames?.[0];
    customerId = first ? (first.split("/").pop() ?? null) : null;
  }

  const now = new Date().toISOString();
  const expiresAt = expiresInSec
    ? new Date(Date.now() + expiresInSec * 1000).toISOString()
    : null;

  // Store the REFRESH token (encrypted) in access_token_encrypted: that column
  // holds the long-lived secret googleClientForShop decrypts and exchanges for
  // short-lived access tokens. Same column Meta uses for its long-lived token.
  const cred = await sb.from("integration_credentials").upsert(
    {
      shop_id: shopId,
      kind: "google_ads",
      access_token_encrypted: encrypt(refreshToken),
      token_expires_at: expiresAt,
      external_account_id: customerId,
      updated_at: now,
    },
    { onConflict: "shop_id,kind" },
  );
  if (cred.error) throw new Response(cred.error.message, { status: 500 });

  // 'pending' so cron.google runs the 90-day backfill on its next tick
  // (cron.google selects sync_status in ('pending','live')).
  const integ = await sb.from("shop_integrations").upsert(
    {
      shop_id: shopId,
      kind: "google_ads",
      sync_status: "pending",
      external_account_id: customerId,
      connected_at: now,
      updated_at: now,
    },
    { onConflict: "shop_id,kind" },
  );
  if (integ.error) throw new Response(integ.error.message, { status: 500 });

  return redirect("/app/settings?google=connected");
};

// One-shot refresh-token -> access-token exchange used only to resolve the
// accessible customer id during the callback. The ongoing per-cron exchange
// lives in app/lib/google/client.server.ts.
async function exchangeRefreshTokenOnce(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }).toString();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as GoogleTokenResponse;
  if (json.error || !json.access_token) {
    throw new Response(
      `Google OAuth token exchange failed: ${json.error_description ?? json.error ?? "no access_token"}`,
      { status: 502 },
    );
  }
  return json.access_token;
}
