// Single-use OAuth `state` nonces for the Meta connect flow.
//
// Replaces the old static, replayable `state` (HMAC-of-shop): that value never
// changed for a given shop, so a leaked `state` could be replayed to bind a
// different ad account to a shop. Here `state` is an unguessable random nonce
// minted at connect-time, stored server-side bound to the shop_id, and consumed
// (deleted) on callback — giving freshness, single-use, and server-side binding.

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/** How long a minted `state` nonce stays valid before the callback must arrive. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Embedded App Bridge context carried through the OAuth round-trip so the
 * provider callback (which lands at the TOP level, outside the Shopify admin
 * iframe) can redirect the merchant back INTO the embedded admin. Neither value
 * is secret — the server-side single-use nonce remains the CSRF/binding guard,
 * and the stored credential is keyed off the nonce's shop_id, never off `shop`
 * here. These only steer where the browser is re-embedded.
 */
// `popup` flags a connect started from the onboarding wizard's NEW-TAB flow: the
// provider callback then lands on the standalone /auth/connected page (close this
// tab + return) instead of an embedded-admin deep link, which can't render in a
// bare top-level tab. Still non-secret — it only steers the final redirect.
// `dashboard` flags a connect started from the standalone dashboard SPA: the
// callback lands back on /dashboard?<provider>=connected|error (no embedded
// admin involved). Same non-secret, redirect-steering-only role as `popup`.
export type OAuthReturnContext = {
  host?: string | null;
  shop?: string | null;
  popup?: boolean;
  dashboard?: boolean;
  returnTo?: string | null;
  origin?: string | null;
};

/**
 * Accept only an allowlisted dashboard origin (the public dashboard URL or the
 * app host itself). Sessions are __Host- cookies locked to the exact host the
 * merchant signed in on, so the post-OAuth redirect must return to THAT origin —
 * landing on the other one bounces through login and drops the one-shot
 * ?<provider>=connected notice. The value is browser-supplied, so it is only
 * ever trusted after matching this env-derived allowlist.
 */
export function safeDashboardOAuthOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const allowed = [process.env.DASHBOARD_PUBLIC_URL, process.env.SHOPIFY_APP_URL]
    .flatMap((base) => {
      if (!base) return [];
      try {
        return [new URL(base).origin];
      } catch {
        return [];
      }
    });
  try {
    const origin = new URL(value).origin;
    return allowed.includes(origin) ? origin : null;
  } catch {
    return null;
  }
}

/** Accept only a same-origin dashboard pathname supplied by the browser. */
export function safeDashboardOAuthReturnTo(value: unknown): string | null {
  if (typeof value !== "string" || (!value.startsWith("/dashboard/") && value !== "/dashboard")) {
    return null;
  }
  if (value.includes("\\") || value.includes("//")) return null;
  try {
    const parsed = new URL(value, "https://dashboard.invalid");
    if (parsed.origin !== "https://dashboard.invalid" || parsed.pathname !== value || parsed.search || parsed.hash) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * Pack the nonce together with the (non-secret) embedded return context into the
 * `state` value sent to the provider. Returns the bare nonce when there is no
 * context, so old callers/flows keep producing plain-nonce states.
 */
export function packOAuthState(nonce: string, ctx?: OAuthReturnContext): string {
  const returnTo = ctx?.dashboard ? safeDashboardOAuthReturnTo(ctx.returnTo) : null;
  const origin = ctx?.dashboard ? safeDashboardOAuthOrigin(ctx.origin) : null;
  if (!ctx?.host && !ctx?.shop && !ctx?.popup && !ctx?.dashboard && !returnTo && !origin) return nonce;
  const payload = {
    n: nonce,
    h: ctx?.host ?? null,
    s: ctx?.shop ?? null,
    p: ctx?.popup ? 1 : 0,
    d: ctx?.dashboard ? 1 : 0,
    r: returnTo,
    o: origin,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Inverse of packOAuthState. A bare nonce (base64url random bytes) never decodes
 * to a JSON object starting with '{', so we fall back to treating the whole
 * value as the nonce — keeping plain-nonce states (and any minted before this
 * change) working.
 */
export function parseOAuthState(state: string): {
  nonce: string;
  host: string | null;
  shop: string | null;
  popup: boolean;
  dashboard: boolean;
  returnTo?: string | null;
  origin?: string | null;
} {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    if (decoded.startsWith("{")) {
      const o = JSON.parse(decoded) as {
        n?: string;
        h?: string | null;
        s?: string | null;
        p?: number;
        d?: number;
        r?: string | null;
        o?: string | null;
      };
      if (o && typeof o.n === "string") {
        const returnTo = safeDashboardOAuthReturnTo(o.r);
        // Re-validate on the way out too: the state travels through the
        // provider and back, so the allowlist runs at use time, not just mint.
        const origin = safeDashboardOAuthOrigin(o.o);
        return {
          nonce: o.n,
          host: o.h ?? null,
          shop: o.s ?? null,
          popup: o.p === 1,
          dashboard: o.d === 1,
          ...(returnTo ? { returnTo } : {}),
          ...(origin ? { origin } : {}),
        };
      }
    }
  } catch {
    /* not a packed state — treat the whole value as the nonce */
  }
  return { nonce: state, host: null, shop: null, popup: false, dashboard: false };
}

/**
 * Where a popup (new-tab) OAuth callback should land: the standalone result page
 * that tells the merchant the connect finished and to return to the setup tab.
 * `?provider=` is the display label, `?status=connected|error`, plus an optional
 * `?reason=` on error. The setup tab itself detects the new pairing by polling
 * the server, so this page only needs to message + (best-effort) close.
 */
export function popupResultUrl(args: {
  provider: string;
  status: "connected" | "error";
  reason?: string;
}): string {
  const params = new URLSearchParams({ provider: args.provider, status: args.status });
  if (args.reason) params.set("reason", args.reason);
  return `/auth/connected?${params.toString()}`;
}

/**
 * Build the redirect back into the embedded admin after a top-level OAuth
 * callback. Preferred form is Shopify's admin deep link
 * (admin.shopify.com/store/<handle>/apps/<api-key><path>?<query>): the admin
 * loads the app iframe at that exact path with the query forwarded and fresh
 * shop/host/session context. Returning to our own domain instead goes through
 * authenticate.admin, which re-enters at the app ROOT and drops the path and
 * the connection notice. Falls back to a same-domain path with shop +
 * (possibly synthesized) host when the api key or shop is unavailable.
 */
export function embeddedReturnUrl(
  path: string,
  query: Record<string, string>,
  ctx: {
    host: string | null;
    shop: string | null;
    dashboard?: boolean;
    returnTo?: string | null;
    origin?: string | null;
  },
): string {
  const params = new URLSearchParams(query);
  // Dashboard-native connect: land back on the dashboard SPA with the same
  // one-shot ?<provider>=connected|error params the embedded Settings reads
  // (connectionNotice). `path` is an /app/* deep link with no meaning outside
  // the Shopify admin, so it is deliberately dropped here. The URL must be
  // ABSOLUTE on the origin the merchant's session lives on: the __Host-
  // session cookie is host-only, and this callback runs on SHOPIFY_APP_URL —
  // a relative redirect (or the wrong host) would strand the merchant on a
  // host with no session, bounce them through login, and drop the one-shot
  // params. Prefer the connect-time origin carried through the state; fall
  // back to the public dashboard URL for states minted before it existed.
  if (ctx.dashboard) {
    const base =
      safeDashboardOAuthOrigin(ctx.origin) ||
      process.env.DASHBOARD_PUBLIC_URL ||
      process.env.SHOPIFY_APP_URL ||
      "";
    const returnTo = safeDashboardOAuthReturnTo(ctx.returnTo) ?? "/dashboard";
    return `${base.replace(/\/$/, "")}${returnTo}?${params.toString()}`;
  }
  const apiKey = process.env.SHOPIFY_API_KEY;
  if (ctx.shop && apiKey) {
    const handle = ctx.shop.replace(/\.myshopify\.com$/, "");
    return `https://admin.shopify.com/store/${handle}/apps/${apiKey}${path}?${params.toString()}`;
  }
  if (ctx.shop) {
    const handle = ctx.shop.replace(/\.myshopify\.com$/, "");
    const host =
      ctx.host || Buffer.from(`admin.shopify.com/store/${handle}`).toString("base64url");
    params.set("shop", ctx.shop);
    params.set("host", host);
  }
  return `${path}?${params.toString()}`;
}

/** Mint a fresh nonce, persist it bound to `shopId`, and return it for `state`. */
export async function createOAuthState(
  sb: SupabaseClient,
  shopId: string,
  ctx?: OAuthReturnContext,
): Promise<string> {
  const nonce = randomBytes(32).toString("base64url");
  const { error } = await sb.from("oauth_state").insert({ nonce, shop_id: shopId });
  if (error) throw error;
  return packOAuthState(nonce, ctx);
}

/**
 * Consume a nonce: delete it and return the bound shop_id, or null if it is
 * unknown, already used, or expired. The delete is the single-use guarantee —
 * a replayed nonce finds no row.
 */
export async function consumeOAuthState(
  sb: SupabaseClient,
  state: string,
): Promise<string | null> {
  const { nonce } = parseOAuthState(state);
  if (!nonce) return null;
  const { data, error } = await sb
    .from("oauth_state")
    .delete()
    .eq("nonce", nonce)
    .select("shop_id, created_at")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as { shop_id: string; created_at: string };
  const createdAt = new Date(row.created_at).getTime();
  if (Number.isFinite(createdAt) && Date.now() - createdAt > OAUTH_STATE_TTL_MS) {
    return null; // expired — the row is already deleted by this consume
  }
  return String(row.shop_id);
}

/**
 * Where a provider's OAuth callback should land the merchant: back inside the
 * onboarding wizard while setup is incomplete, the Settings page afterwards.
 * Connecting from onboarding used to strand merchants on Settings mid-wizard.
 */
export async function postOAuthPath(sb: SupabaseClient, shopId: string): Promise<string> {
  const { data, error } = await sb
    .from("shops")
    .select("onboarding_step, onboarding_completed_at")
    .eq("id", shopId)
    .maybeSingle();
  if (error) throw error;
  const row = data as { onboarding_step: string | null; onboarding_completed_at: string | null } | null;
  const done = Boolean(row?.onboarding_completed_at) || row?.onboarding_step === "complete";
  return done ? "/app/settings" : "/app/onboarding";
}
