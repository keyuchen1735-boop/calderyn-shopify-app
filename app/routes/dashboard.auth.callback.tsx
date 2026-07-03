// app/routes/dashboard.auth.callback.tsx
// Finishes the dashboard OAuth round-trip. The exchanged access token is
// discarded — the grant only proves the requester controls the shop. The shop
// must already exist in Supabase (app installed) to get a session.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  isValidShopDomain,
  verifyShopifyHmac,
  exchangeCodeForToken,
} from "~/lib/dashboard/shopify-oauth.server";
import { createSession, sessionCookieHeader } from "~/lib/dashboard/session.server";
import {
  jsonError,
  rateLimit,
  clientIpKey,
  safeDashboardReturnTo,
  publicBaseUrl,
} from "~/lib/dashboard/http.server";
import { resolveShopId } from "~/lib/supabase.server";
import {
  STATE_COOKIE_NAME,
  shopHintCookieHeader,
  expireCookieHeader,
} from "~/lib/dashboard/cookies.server";

function readStateCookie(
  request: Request,
): { nonce: string; shop: string; returnTo: string | null } | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === STATE_COOKIE_NAME) {
      // Cookie format is `nonce:shop[:enc(returnTo)]`. Only the returnTo segment
      // is URL-encoded (login.tsx), so split first and decode that segment ONCE
      // — decoding the whole value would double-decode returnTo and throw on a
      // surviving `%` sequence (a 500 on the post-login redirect).
      const [nonce, shop, ...ret] = rest.join("=").split(":");
      if (nonce && shop) {
        let returnTo: string | null = null;
        if (ret.length) {
          try {
            returnTo = decodeURIComponent(ret.join(":"));
          } catch {
            returnTo = null; // malformed encoding — fall back to /dashboard
          }
        }
        return { nonce, shop, returnTo };
      }
    }
  }
  return null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!(await rateLimit(clientIpKey(request, "dash-callback"), 10, 60_000))) {
    return jsonError(429, "rate_limited");
  }

  const publicUrl = publicBaseUrl();
  const failure = redirect(`${publicUrl}/dashboard/login?error=oauth_failed`, {
    headers: { "Set-Cookie": expireCookieHeader(STATE_COOKIE_NAME) },
  });

  const url = new URL(request.url);
  const shop = (url.searchParams.get("shop") ?? "").toLowerCase();
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";

  const cookieState = readStateCookie(request);
  if (
    !isValidShopDomain(shop) ||
    !code ||
    !cookieState ||
    cookieState.nonce !== state ||
    cookieState.shop !== shop ||
    !verifyShopifyHmac(url.searchParams, process.env.SHOPIFY_API_SECRET ?? "")
  ) {
    return failure;
  }

  const accepted = await exchangeCodeForToken({
    shop,
    code,
    clientId: process.env.SHOPIFY_API_KEY ?? "",
    clientSecret: process.env.SHOPIFY_API_SECRET ?? "",
  });
  if (!accepted) return failure;

  // Gate: only shops with the app installed (provisioned in Supabase) may sign
  // in — the import pipeline runs on the offline token minted at install, so an
  // uninstalled shop has nothing to port. Friendly page, not raw JSON.
  let shopId: string;
  try {
    shopId = await resolveShopId(shop);
  } catch {
    return redirect(`${publicUrl}/dashboard/login?error=app_not_installed&shop=${encodeURIComponent(shop)}`, {
      headers: { "Set-Cookie": expireCookieHeader(STATE_COOKIE_NAME) },
    });
  }

  const { raw } = await createSession(shop);
  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookieHeader(raw));
  // Remember the shop so a future visit to /dashboard/login pre-fills the
  // store-domain form (it no longer triggers any automatic redirect).
  headers.append("Set-Cookie", shopHintCookieHeader(shop));
  headers.append("Set-Cookie", expireCookieHeader(STATE_COOKIE_NAME));
  // Destination: an explicit validated return_to wins (connector consent flow);
  // otherwise a shop that never finished a data port lands on the import screen
  // (the "Continue with Shopify" promise), and everyone else on the home.
  let dest = safeDashboardReturnTo(cookieState.returnTo);
  if (!dest) {
    try {
      // Lazy-loaded: run.server pulls the ingest/shopify.server chain — keep
      // that out of this auth route's module graph (module-load env coupling).
      const { latestImport } = await import("~/lib/import/run.server");
      const last = await latestImport(shopId);
      dest = last?.state === "done" ? "/dashboard" : "/dashboard/settings/import";
    } catch {
      dest = "/dashboard"; // a broken poll must not break sign-in
    }
  }
  return redirect(`${publicUrl}${dest}`, { headers });
}
