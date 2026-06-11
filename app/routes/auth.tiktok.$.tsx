import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  exchangeCodeForToken,
  type TikTokTokenResponse,
} from "~/lib/tiktok/oauth.server";
import {
  consumeOAuthState,
  parseOAuthState,
  embeddedReturnUrl,
  postOAuthPath,
} from "~/lib/meta/oauth-state.server";
import { getSupabase } from "~/lib/supabase.server";
import { encrypt } from "~/lib/crypto.server";

// TikTok Business OAuth callback. Mirrors app/routes/auth.meta.$.tsx:
//   1. consume the single-use `state` nonce (CSRF + resolves the shop),
//   2. exchange the auth code for an access token + advertiser id,
//   3. upsert the ENCRYPTED access token into integration_credentials, and
//   4. upsert shop_integrations (kind tiktok_ads, sync_status='pending').
//
// TikTok returns its auth grant as `auth_code` (not `code`). No
// `authenticate.admin`: the redirect arrives from TikTok's domain without the
// embedded app session, so the single-use nonce is the authenticator (same as
// auth.meta / auth.google).

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  // TikTok sends the grant as `auth_code`; accept `code` as a fallback.
  const authCode = url.searchParams.get("auth_code") ?? url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const appId = process.env.TIKTOK_APP_ID;
  const appSecret = process.env.TIKTOK_APP_SECRET;

  // Recover the embedded App Bridge context (shop/host) carried through `state`
  // so the redirects below land back on the embedded settings page instead of
  // dead-ending top-level (mirrors auth.google.$.tsx / auth.quickbooks.$.tsx).
  const returnCtx = parseOAuthState(state ?? "");

  if (oauthError) {
    return redirect(
      embeddedReturnUrl("/app/settings", { tiktok: "error", reason: oauthError }, returnCtx),
    );
  }
  if (!authCode || !state || !appId || !appSecret) {
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
  ): Promise<TikTokTokenResponse> =>
    (await fetch(u, init)).json() as Promise<TikTokTokenResponse>;

  const { accessToken, advertiserId, expiresInSec } = await exchangeCodeForToken(fetcher, {
    appId,
    appSecret,
    code: authCode,
  });

  const now = new Date().toISOString();
  const expiresAt = expiresInSec
    ? new Date(Date.now() + expiresInSec * 1000).toISOString()
    : null;

  const cred = await sb.from("integration_credentials").upsert(
    {
      shop_id: shopId,
      kind: "tiktok_ads",
      access_token_encrypted: encrypt(accessToken),
      token_expires_at: expiresAt,
      external_account_id: advertiserId,
      updated_at: now,
    },
    { onConflict: "shop_id,kind" },
  );
  if (cred.error) throw new Response(cred.error.message, { status: 500 });

  const integ = await sb.from("shop_integrations").upsert(
    {
      shop_id: shopId,
      kind: "tiktok_ads",
      sync_status: "pending",
      external_account_id: advertiserId,
      connected_at: now,
      updated_at: now,
    },
    { onConflict: "shop_id,kind" },
  );
  if (integ.error) throw new Response(integ.error.message, { status: 500 });

  return redirect(embeddedReturnUrl(await postOAuthPath(sb, shopId), { tiktok: "connected" }, returnCtx));
};
