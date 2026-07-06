// app/routes/dashboard.auth.callback.tsx
// Finishes the dashboard OAuth round-trip. Approve IS the install: the
// exchanged offline token is persisted (the import/ingest pipelines run on
// it), the tenant is provisioned/reactivated, the shared install routine runs
// (parity with the embedded afterAuth), and a first connect auto-starts the
// data port before landing the merchant on the native store.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Session } from "@shopify/shopify-api";
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
  SHOPLESS_STATE_SHOP,
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
  // Normal round-trips pin a real shop and must match exactly. The `*` sentinel
  // (legacy shop-less initiation, no longer emitted by /dashboard/login) is
  // still accepted so an OAuth flow begun before that change completes:
  // identity then comes from the HMAC-verified callback params — signed with
  // our app secret — plus the code exchange below proving shop control.
  const hmacOk = verifyShopifyHmac(url.searchParams, process.env.SHOPIFY_API_SECRET ?? "");
  if (
    !isValidShopDomain(shop) ||
    !code ||
    !cookieState ||
    cookieState.nonce !== state ||
    (cookieState.shop !== shop && cookieState.shop !== SHOPLESS_STATE_SHOP) ||
    !hmacOk
  ) {
    // The guard previously failed silently, masking which precondition rejected
    // the round-trip. Log booleans + param/header NAMES only — never the token,
    // secret, code, or hmac value.
    const cookieHeader = request.headers.get("Cookie") ?? "";
    console.error("[dashboard.auth.callback] oauth_failed at guard", {
      shopValid: isValidShopDomain(shop),
      hasCode: !!code,
      hasStateCookie: !!cookieState,
      nonceMatch: cookieState ? cookieState.nonce === state : null,
      shopMatch: cookieState
        ? cookieState.shop === shop || cookieState.shop === SHOPLESS_STATE_SHOP
        : null,
      hmacOk,
      cookieHeaderPresent: cookieHeader.length > 0,
      stateCookieInHeader: cookieHeader.includes(STATE_COOKIE_NAME),
      paramKeys: [...url.searchParams.keys()].sort().join(","),
      xForwardedHost: request.headers.get("x-forwarded-host"),
      host: request.headers.get("host"),
    });
    return failure;
  }

  const grant = await exchangeCodeForToken({
    shop,
    code,
    clientId: process.env.SHOPIFY_API_KEY ?? "",
    clientSecret: process.env.SHOPIFY_API_SECRET ?? "",
  });
  if (!grant) {
    console.error("[dashboard.auth.callback] oauth_failed: token exchange returned null", { shop });
    return failure;
  }

  // Keep the offline token: the import/ingest pipelines read this session row
  // (unauthenticated.admin), and for a shop that connects here before ever
  // opening the embedded app this grant IS the install. Stored through the
  // library (not a hand-rolled row) so the shape — including the expiry and
  // refresh token that expiringOfflineAccessTokens needs — can't drift from
  // what PrismaSessionStorage reads back. Lazy-loaded like run.server below —
  // keep shopify.server's module graph out of this auth route's.
  try {
    const { sessionStorage } = await import("../shopify.server");
    await sessionStorage.storeSession(
      new Session({
        // The library's stable offline-session id format (Session.getOfflineId
        // needs a full api config object, so the literal is used here).
        id: `offline_${shop}`,
        shop,
        state: "",
        isOnline: false,
        scope: grant.scope,
        accessToken: grant.accessToken,
        ...(grant.expiresIn ? { expires: new Date(Date.now() + grant.expiresIn * 1000) } : {}),
        ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}),
        ...(grant.refreshTokenExpiresIn
          ? { refreshTokenExpires: new Date(Date.now() + grant.refreshTokenExpiresIn * 1000) }
          : {}),
      }),
    );
  } catch (err) {
    // Without the token the "your data comes with you" promise can't be kept —
    // fail the round-trip visibly instead of minting a session that can't port.
    console.error("[dashboard.auth.callback] offline session write failed", err);
    return failure;
  }

  // The shared install routine — the same one the embedded afterAuth runs —
  // provisions/reactivates the tenant (clearing uninstalled_at so a
  // re-connecting shop escapes the GDPR sweep), registers the CarrierService,
  // and enqueues the ingest pipeline. Best-effort: only the tenant is
  // load-bearing, and that's gated by resolveShopId below; the rest retries on
  // the next embedded open or re-connect. (The token row above intentionally
  // precedes this — the install routine's admin client reads it.)
  try {
    const { unauthenticated } = await import("../shopify.server");
    const { admin } = await unauthenticated.admin(shop);
    const { completeShopInstall } = await import("~/lib/install.server");
    await completeShopInstall({ shop, admin, inlineBackfill: false });
  } catch (err) {
    console.error("[dashboard.auth.callback] install routine failed", err);
  }

  // Tenant gate: without a provisioned shop there is nothing to sign in to.
  // Reached only when the install routine failed at provisioning (e.g. a
  // Supabase outage) — the error page copy is a retry, not an install ask.
  let shopId: string;
  try {
    shopId = await resolveShopId(shop);
  } catch (err) {
    console.error("[dashboard.auth.callback] tenant unresolved after install", err);
    return redirect(`${publicUrl}/dashboard/login?error=app_not_installed&shop=${encodeURIComponent(shop)}`, {
      headers: { "Set-Cookie": expireCookieHeader(STATE_COOKIE_NAME) },
    });
  }

  const { raw } = await createSession(shop);
  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookieHeader(raw));
  // Remember the shop so a bounce-back error page can offer a retry that
  // targets the right store (there is no store-domain form anymore).
  headers.append("Set-Cookie", shopHintCookieHeader(shop));
  headers.append("Set-Cookie", expireCookieHeader(STATE_COOKIE_NAME));
  // The port runs itself: a first connect (no run on record) queues one right
  // here and nudges the drain so the pull starts before the next cron tick.
  // A shop whose last run ERRORED is deliberately not re-queued — restarting a
  // deterministically-failing 12-month pull on every sign-in would starve the
  // drain — it lands on the import screen, which owns the error + manual
  // retry. Destination: an explicit validated return_to wins (connector
  // consent flow); done → home; error → import screen; otherwise the native
  // store while the data streams in.
  let dest = safeDashboardReturnTo(cookieState.returnTo);
  try {
    // Lazy-loaded: run.server pulls the ingest/shopify.server chain — keep
    // that out of this auth route's module graph (module-load env coupling).
    const { latestImport, startImport, kickDrainSoon } = await import("~/lib/import/run.server");
    const last = await latestImport(shopId);
    if (!last) {
      await startImport(shopId);
      await kickDrainSoon();
    }
    if (!dest) {
      dest =
        last?.state === "done"
          ? "/dashboard"
          : last?.state === "error"
            ? "/dashboard/settings/import"
            : "/dashboard/store";
    }
  } catch (err) {
    // Auto-port failed: land on the import screen, where the state is honest
    // and a manual retry lives — never a silent empty home.
    console.error("[dashboard.auth.callback] auto-port failed", err);
    if (!dest) dest = "/dashboard/settings/import";
  }
  return redirect(`${publicUrl}${dest}`, { headers });
}
