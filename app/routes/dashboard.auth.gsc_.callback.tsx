// app/routes/dashboard.auth.gsc_.callback.tsx
// Google Search Console OAuth callback. Validates the single-use CSRF nonce,
// exchanges the code for a refresh token (stored encrypted), then returns the
// merchant to the dashboard. Mirrors app/routes/auth.google.$.tsx: the nonce is
// the authenticator because the redirect arrives from Google's domain without a
// dashboard session cookie.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { consumeOAuthState } from "~/lib/meta/oauth-state.server";
import { exchangeAndStore } from "~/lib/seo/google-search-console.server";
import { publicBaseUrl } from "~/lib/dashboard/http.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  // Absolute base: this callback runs on the app origin; the dashboard SPA reads
  // ?search=connected|error the same way it reads ?google=connected.
  const base = publicBaseUrl();
  const sb = getSupabase();

  if (!code || !state) return redirect(`${base}/dashboard?search=error&reason=missing_params`);

  let shopId: string | null;
  try {
    shopId = await consumeOAuthState(sb, state);
  } catch {
    shopId = null;
  }
  if (!shopId) return redirect(`${base}/dashboard?search=error&reason=bad_state`);

  try {
    await exchangeAndStore(shopId, code);
  } catch (err) {
    console.error("[seo/gsc] callback exchange failed", err);
    return redirect(`${base}/dashboard?search=error&reason=exchange_failed`);
  }
  return redirect(`${base}/dashboard?search=connected`);
}
