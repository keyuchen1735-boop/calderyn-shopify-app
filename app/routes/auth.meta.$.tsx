import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  exchangeCodeForToken,
  type GraphTokenResponse,
} from "~/lib/meta/oauth.server";
import {
  consumeOAuthState,
  parseOAuthState,
  embeddedReturnUrl,
  popupResultUrl,
  postOAuthPath,
} from "~/lib/meta/oauth-state.server";
import { getSupabase } from "~/lib/supabase.server";
import { encrypt } from "~/lib/crypto.server";
import { grantedScopesFromPermissions } from "~/lib/integration-status";

const GRAPH_VERSION = "v21.0";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const appUrl = process.env.SHOPIFY_APP_URL;

  // Embedded App Bridge context (shop/host) carried through `state`, used to
  // re-embed the merchant in the Shopify admin on the final redirect (a bare
  // top-level redirect dead-ends on a 410 HTML page).
  const returnCtx = parseOAuthState(state ?? "");

  // Surface a user-declined consent cleanly rather than as a 400 (mirrors
  // auth.google/tiktok/quickbooks). Facebook sends ?error=...&state=... with no
  // code when the merchant clicks Cancel.
  if (oauthError) {
    // New-tab (onboarding) connect: land on the standalone result page, not an
    // embedded deep link that can't render in a bare tab.
    if (returnCtx.popup)
      return redirect(popupResultUrl({ provider: "Meta Ads", status: "error", reason: oauthError }));
    return redirect(
      embeddedReturnUrl("/app/settings", { meta: "error", reason: oauthError }, returnCtx),
    );
  }
  if (!code || !state || !appId || !appSecret || !appUrl) {
    throw new Response("Missing OAuth parameters", { status: 400 });
  }

  // Consume the single-use state nonce up front: this both authenticates the
  // callback (only a nonce we minted is accepted) and resolves the destination
  // shop. Reject before doing any token exchange if it is invalid/expired/reused.
  const sb = getSupabase();
  const shopId = await consumeOAuthState(sb, state);
  if (!shopId) throw new Response("Invalid or expired OAuth state", { status: 400 });

  const fetcher = async (u: string): Promise<GraphTokenResponse> =>
    (await fetch(u)).json() as Promise<GraphTokenResponse>;
  const { accessToken, expiresInSec } = await exchangeCodeForToken(fetcher, {
    appId,
    appSecret,
    redirectUri: `${appUrl}/auth/meta`,
    code,
  });

  // Resolve the first ad account for this user.
  const accountsRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/me/adaccounts?fields=account_id&access_token=${encodeURIComponent(accessToken)}`,
  );
  const accounts = (await accountsRes.json()) as {
    data?: Array<{ account_id?: string }>;
    error?: { message: string };
  };
  if (accounts.error) throw new Response(`Meta error: ${accounts.error.message}`, { status: 502 });
  const accountId = accounts.data?.[0]?.account_id;
  const adAccountId = accountId ? `act_${accountId}` : null;

  const now = new Date().toISOString();
  const expiresAt = expiresInSec ? new Date(Date.now() + expiresInSec * 1000).toISOString() : null;

  // Capture the actually-granted scopes so the UI can gate the creative-draft
  // push deterministically. Best-effort: a permissions read failure leaves
  // scopes "" (push stays disabled) rather than failing the connection.
  let grantedScopes = "";
  try {
    const permsRes = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/me/permissions?access_token=${encodeURIComponent(accessToken)}`,
    );
    grantedScopes = grantedScopesFromPermissions(await permsRes.json());
  } catch {
    grantedScopes = "";
  }

  const cred = await sb.from("integration_credentials").upsert(
    {
      shop_id: shopId,
      kind: "meta_ads",
      access_token_encrypted: encrypt(accessToken),
      token_expires_at: expiresAt,
      external_account_id: adAccountId,
      scopes: grantedScopes,
      updated_at: now,
    },
    { onConflict: "shop_id,kind" },
  );
  if (cred.error) throw new Response(cred.error.message, { status: 500 });

  const integ = await sb.from("shop_integrations").upsert(
    {
      shop_id: shopId,
      kind: "meta_ads",
      sync_status: "ready",
      // Clear any sync_error from a prior failed sync so Settings doesn't keep
      // showing a stale failure message for this fresh pairing (mirrors
      // auth.google.$.tsx).
      sync_error: null,
      external_account_id: adAccountId,
      connected_at: now,
      updated_at: now,
    },
    { onConflict: "shop_id,kind" },
  );
  if (integ.error) throw new Response(integ.error.message, { status: 500 });

  if (returnCtx.popup) return redirect(popupResultUrl({ provider: "Meta Ads", status: "connected" }));
  return redirect(embeddedReturnUrl(await postOAuthPath(sb, shopId), { meta: "connected" }, returnCtx));
};
