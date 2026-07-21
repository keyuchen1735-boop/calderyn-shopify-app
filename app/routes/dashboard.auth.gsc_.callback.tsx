// app/routes/dashboard.auth.gsc_.callback.tsx
// Google Search Console OAuth callback: verify state, exchange the code,
// store the encrypted refresh token, auto-pick the matching GSC property,
// and mark the shop connected. Errors land back on the Search screen.
import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { expireCookieHeader } from "~/lib/dashboard/cookies.server";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { exchangeGscCode, saveGscCredential, GSC_STATE_COOKIE, gscRedirectUri } from "~/lib/seo/gsc.server";
import { listGscSites, pickSiteForOrigin } from "~/lib/seo/search-console.server";
import { getShopStorefrontOrigin } from "~/lib/storefront/shop.server";
import { getSupabase } from "~/lib/supabase.server";

const CLEAR_STATE = expireCookieHeader(GSC_STATE_COOKIE);

function back(result: "google-connected" | "google-error", reason?: string): Response {
  const q = new URLSearchParams({ search: result });
  if (reason) q.set("reason", reason);
  return redirect(`/dashboard/store/preferences?${q.toString()}`, { headers: { "set-cookie": CLEAR_STATE } });
}

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requireDashboardSession(request);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = cookieValue(request, GSC_STATE_COOKIE);
  if (!code || !state || !expected || state !== expected) return back("google-error", "state_mismatch");
  try {
    const { refreshToken, accessToken } = await exchangeGscCode(code, gscRedirectUri());
    if (!refreshToken) return back("google-error", "no_refresh_token");
    await saveGscCredential(session.shopId, refreshToken);
    const origin = await getShopStorefrontOrigin(session.shopId);
    const site = origin ? pickSiteForOrigin(await listGscSites(accessToken), origin) : null;
    // seo_settings may have no row yet for a shop that never touched SEO
    // settings, so upsert on shop_id rather than update (which would match
    // zero rows and silently no-op). upsertSeoSettings (seo-store.server.ts)
    // doesn't cover gsc_connected/gsc_site_url, so write directly here.
    const { error } = await getSupabase()
      .from("seo_settings")
      .upsert(
        { shop_id: session.shopId, gsc_connected: true, gsc_site_url: site, updated_at: new Date().toISOString() },
        { onConflict: "shop_id" },
      );
    if (error) throw new Error(error.message);
    return back("google-connected");
  } catch (err) {
    console.error("[gsc] connect failed", err);
    return back("google-error", "exchange_failed");
  }
};
