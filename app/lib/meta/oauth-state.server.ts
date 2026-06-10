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
export type OAuthReturnContext = { host?: string | null; shop?: string | null };

/**
 * Pack the nonce together with the (non-secret) embedded return context into the
 * `state` value sent to the provider. Returns the bare nonce when there is no
 * context, so old callers/flows keep producing plain-nonce states.
 */
export function packOAuthState(nonce: string, ctx?: OAuthReturnContext): string {
  if (!ctx?.host && !ctx?.shop) return nonce;
  const payload = { n: nonce, h: ctx.host ?? null, s: ctx.shop ?? null };
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
} {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    if (decoded.startsWith("{")) {
      const o = JSON.parse(decoded) as { n?: string; h?: string | null; s?: string | null };
      if (o && typeof o.n === "string") {
        return { nonce: o.n, host: o.h ?? null, shop: o.s ?? null };
      }
    }
  } catch {
    /* not a packed state — treat the whole value as the nonce */
  }
  return { nonce: state, host: null, shop: null };
}

/**
 * Build a redirect path back into the embedded admin, carrying the App Bridge
 * `shop`/`host` recovered from the OAuth state. authenticate.admin requires BOTH
 * params to re-embed a top-level callback into the Shopify admin iframe; without
 * them the embedded route dead-ends on the app login page. `host` is just
 * base64url("admin.shopify.com/store/<handle>"), so when the packed state lost
 * it (the connect form's ?host= is empty after client-side navigation) it is
 * synthesized from the shop domain instead of falling back to a bare path.
 */
export function embeddedReturnUrl(
  path: string,
  query: Record<string, string>,
  ctx: { host: string | null; shop: string | null },
): string {
  const params = new URLSearchParams(query);
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
