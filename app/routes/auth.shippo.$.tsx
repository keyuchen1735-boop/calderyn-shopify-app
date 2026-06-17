import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { exchangeCodeForToken } from "~/lib/shippo/oauth.server";
import {
  consumeOAuthState,
  parseOAuthState,
  embeddedReturnUrl,
  postOAuthPath,
} from "~/lib/meta/oauth-state.server";
import { getSupabase } from "~/lib/supabase.server";
import { encrypt } from "~/lib/crypto.server";

// Shippo OAuth callback (ship-cost connector #2). Mirrors app/routes/auth.quickbooks.$.tsx:
//   1. consume the single-use `state` nonce (CSRF + resolves the shop),
//   2. exchange the code for a co-branded access token (form "oauth.<token>"),
//   3. store the ENCRYPTED access token in integration_credentials
//      (access_token_encrypted column, kind 'shippo_ship') with token_expires_at=null
//      because Shippo OAuth tokens NEVER expire (no refresh token), and
//   4. upsert shop_integrations(kind='shippo_ship', sync_status='ready') so
//      cron.ingest-ship-costs picks the shop up on its next tick (shipAdaptersForShops
//      includes 'ready', contract §8.1).
//
// No authenticate.admin: the redirect arrives from Shippo's domain without the
// embedded session, so the single-use nonce is the authenticator (QuickBooks precedent).
//
// Shippo carries no `realmId` equivalent; the account id, if the exchange returns one,
// is stored as external_account_id (else null).

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const clientId = process.env.SHIPPO_CLIENT_ID;
  const clientSecret = process.env.SHIPPO_CLIENT_SECRET;
  const appUrl = process.env.SHOPIFY_APP_URL;

  // Recover the embedded App Bridge context (shop/host) carried through `state` so the
  // redirects below re-embed the merchant in the Shopify admin (mirrors QuickBooks).
  const returnCtx = parseOAuthState(state ?? "");

  if (oauthError) {
    return redirect(
      embeddedReturnUrl("/app/settings", { shippo: "error", reason: oauthError }, returnCtx),
    );
  }
  if (!code || !state || !clientId || !clientSecret || !appUrl) {
    throw new Response("Missing OAuth parameters", { status: 400 });
  }

  const sb = getSupabase();
  const shopId = await consumeOAuthState(sb, state);
  if (!shopId) throw new Response("Invalid or expired OAuth state", { status: 400 });

  const fetcher = async (
    u: string,
    init: { method: "POST"; headers: Record<string, string>; body: string },
  ) => (await fetch(u, init)).json();

  const tok = await exchangeCodeForToken(fetcher, {
    clientId,
    clientSecret,
    redirectUri: `${appUrl}/auth/shippo`,
    code,
  });

  const now = new Date().toISOString();

  // Store the NON-EXPIRING access token (encrypted) in access_token_encrypted — same
  // column/path the OAuth integrations use. token_expires_at is null (Shippo tokens
  // never expire; there is no refresh token to rotate). NOT the legacy
  // shop_integrations.access_token_enc bytea (contract C7).
  const cred = await sb.from("integration_credentials").upsert(
    {
      shop_id: shopId,
      kind: "shippo_ship",
      access_token_encrypted: encrypt(tok.accessToken),
      token_expires_at: null,
      external_account_id: tok.accountId,
      updated_at: now,
    },
    { onConflict: "shop_id,kind" },
  );
  if (cred.error) throw new Response(cred.error.message, { status: 500 });

  const integ = await sb.from("shop_integrations").upsert(
    {
      shop_id: shopId,
      kind: "shippo_ship",
      sync_status: "ready",
      // Clear any sync_error from a prior failed sync so Settings doesn't keep showing
      // a stale failure message for this fresh pairing (mirrors QuickBooks).
      sync_error: null,
      external_account_id: tok.accountId,
      connected_at: now,
      updated_at: now,
    },
    { onConflict: "shop_id,kind" },
  );
  if (integ.error) throw new Response(integ.error.message, { status: 500 });

  return redirect(embeddedReturnUrl(await postOAuthPath(sb, shopId), { shippo: "connected" }, returnCtx));
};
