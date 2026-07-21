import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { exchangeCodeForToken } from "~/lib/quickbooks/oauth.server";
import {
  consumeOAuthState,
  parseOAuthState,
  embeddedReturnUrl,
  popupResultUrl,
  postOAuthPath,
} from "~/lib/meta/oauth-state.server";
import { getSupabase } from "~/lib/supabase.server";
import { encrypt } from "~/lib/crypto.server";

// QuickBooks Online OAuth callback. Mirrors app/routes/auth.google.$.tsx:
//   1. consume the single-use `state` nonce (CSRF + resolves the shop),
//   2. exchange the code for { access, refresh } tokens,
//   3. store the ENCRYPTED refresh token in integration_credentials
//      (access_token_encrypted column, Google precedent) + realmId, and
//   4. upsert shop_integrations(kind='quickbooks', sync_status='ready') so
//      cron.ingest-quickbooks picks the shop up on its next tick.
//
// No authenticate.admin: the redirect arrives from Intuit's domain without the
// embedded session, so the single-use nonce is the authenticator.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const realmId = url.searchParams.get("realmId");
  const oauthError = url.searchParams.get("error");
  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const appUrl = process.env.SHOPIFY_APP_URL;

  // Recover the embedded App Bridge context (shop/host) carried through `state`
  // so the redirects below re-embed the merchant in the Shopify admin instead of
  // dead-ending top-level (mirrors auth.google.$.tsx).
  const returnCtx = parseOAuthState(state ?? "");

  if (oauthError) {
    if (returnCtx.popup)
      return redirect(popupResultUrl({ provider: "QuickBooks", status: "error", reason: oauthError }));
    return redirect(
      embeddedReturnUrl("/app/settings", { quickbooks: "error", reason: oauthError }, returnCtx),
    );
  }
  if (!code || !state || !realmId || !clientId || !clientSecret || !appUrl) {
    throw new Response("Missing OAuth parameters", { status: 400 });
  }

  const sb = getSupabase();
  const shopId = await consumeOAuthState(sb, state);
  if (!shopId) {
    // Single-use nonce already consumed or past its 10-minute TTL (merchant
    // lingered on Intuit's consent/login screens). For dashboard-started
    // connects the packed return context still parses, so send them back to
    // the dashboard with the one-shot error notice (a toast + retry beats a
    // bare 400 page). Non-dashboard flows keep the hard 400.
    if (returnCtx.dashboard) {
      return redirect(embeddedReturnUrl("/dashboard", { quickbooks: "error", reason: "expired, please retry" }, returnCtx));
    }
    throw new Response("Invalid or expired OAuth state", { status: 400 });
  }

  const fetcher = async (
    u: string,
    init: { method: "POST"; headers: Record<string, string>; body: string },
  ) => (await fetch(u, init)).json();

  const tok = await exchangeCodeForToken(fetcher, {
    clientId,
    clientSecret,
    redirectUri: `${appUrl}/auth/quickbooks`,
    code,
  });

  const now = new Date().toISOString();
  const refreshExpiresAt = tok.refreshExpiresInSec
    ? new Date(Date.now() + tok.refreshExpiresInSec * 1000).toISOString()
    : null;

  // Store the rotating REFRESH token (encrypted) in access_token_encrypted —
  // same column/path Google uses. The access token is re-derived each cron run.
  const cred = await sb.from("integration_credentials").upsert(
    {
      shop_id: shopId,
      kind: "quickbooks",
      access_token_encrypted: encrypt(tok.refreshToken),
      token_expires_at: refreshExpiresAt,
      external_account_id: realmId,
      updated_at: now,
    },
    { onConflict: "shop_id,kind" },
  );
  if (cred.error) throw new Response(cred.error.message, { status: 500 });

  const integ = await sb.from("shop_integrations").upsert(
    {
      shop_id: shopId,
      kind: "quickbooks",
      sync_status: "ready",
      // Clear any sync_error from a prior failed sync so Settings doesn't keep
      // showing a stale failure message for this fresh pairing (mirrors
      // auth.google.$.tsx).
      sync_error: null,
      external_account_id: realmId,
      connected_at: now,
      updated_at: now,
    },
    { onConflict: "shop_id,kind" },
  );
  if (integ.error) throw new Response(integ.error.message, { status: 500 });

  if (returnCtx.popup) return redirect(popupResultUrl({ provider: "QuickBooks", status: "connected" }));
  return redirect(embeddedReturnUrl(await postOAuthPath(sb, shopId), { quickbooks: "connected" }, returnCtx));
};
