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

/** Mint a fresh nonce, persist it bound to `shopId`, and return it for `state`. */
export async function createOAuthState(
  sb: SupabaseClient,
  shopId: string,
): Promise<string> {
  const nonce = randomBytes(32).toString("base64url");
  const { error } = await sb.from("oauth_state").insert({ nonce, shop_id: shopId });
  if (error) throw error;
  return nonce;
}

/**
 * Consume a nonce: delete it and return the bound shop_id, or null if it is
 * unknown, already used, or expired. The delete is the single-use guarantee —
 * a replayed nonce finds no row.
 */
export async function consumeOAuthState(
  sb: SupabaseClient,
  nonce: string,
): Promise<string | null> {
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
