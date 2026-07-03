// app/lib/buyer/magic-link.server.ts
//
// Passwordless buyer login (platform pivot #1b). A magic link is a single-use, 15-minute token
// emailed to the buyer; clicking it (and confirming) mints a buyer session. Token lifecycle
// mirrors auth/reset.server.ts: only the peppered HMAC-SHA256 hash is stored, and consume is an
// ATOMIC single-use claim (consumed_at IS NULL) so a token works exactly once.
//
// Signup and login are unified: requesting a link UPSERTS the buyer (idempotent by shop+email),
// so a first-time buyer's first link both creates their account and logs them in. This also makes
// the endpoint NON-ENUMERABLE — the response is identical whether or not the email already had an
// account, so it never reveals which emails are registered.

import { getSupabase } from "~/lib/supabase.server";
import { upsertGuestBuyer, normalizeEmail } from "./identity.server";
import { hashBuyerToken, newBuyerSessionToken } from "./session.server";
import { sendEmail } from "~/lib/email/send.server";

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Mint a magic-link token for (shop, buyer). Returns the RAW token to embed in the emailed link. */
export async function createMagicLink(shopId: string, buyerId: string): Promise<{ raw: string }> {
  if (!shopId) throw new Error("shopId is required");
  if (!buyerId) throw new Error("buyerId is required");
  // Reuse the session token generator for a 256-bit CSPRNG token; the `buyer_live_` prefix is
  // cosmetic here (the token is never used as a session — it is single-use and consumed for one).
  const raw = newBuyerSessionToken();
  const { error } = await getSupabase()
    .from("buyer_magic_link")
    .insert({
      shop_id: shopId,
      buyer_id: buyerId,
      token_hash: hashBuyerToken(raw),
      expires_at: new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { raw };
}

/**
 * Consume a magic-link token WITHIN a shop: atomic single-use claim. Returns the buyer id on
 * success, or null when the token is unknown, for another shop, expired, or already consumed.
 * The UPDATE itself is the guard (consumed_at IS NULL), so two concurrent consumers of the same
 * token can't both succeed.
 */
export async function consumeMagicLink(shopId: string, raw: string): Promise<{ buyerId: string } | null> {
  if (!shopId) throw new Error("shopId is required");
  if (!raw) return null;

  const sb = getSupabase();
  const { data, error } = await sb
    .from("buyer_magic_link")
    .select("id, buyer_id, expires_at, consumed_at")
    .eq("shop_id", shopId)
    .eq("token_hash", hashBuyerToken(raw))
    .maybeSingle();
  if (error) throw error;
  if (!data || data.consumed_at) return null;
  if (new Date(String(data.expires_at)).getTime() <= Date.now()) return null;

  const { data: claimed, error: updateError } = await sb
    .from("buyer_magic_link")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", data.id)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!claimed) return null; // lost the race — already consumed
  return { buyerId: String(data.buyer_id) };
}

/**
 * Public entrypoint: request a login link for `email` on `shopId`. Upserts the buyer (signup +
 * login are one flow) and emails the link. Returns void ALWAYS — the caller sends the same
 * "check your email" response regardless, so the endpoint never reveals whether the email is
 * registered. Never throws on a delivery failure (sendEmail returns a structured result); a
 * failed send is logged so an operator can see it (rule 12) without leaking to the buyer.
 */
export async function requestBuyerMagicLink(shopId: string, email: string, baseUrl: string): Promise<void> {
  if (!shopId) throw new Error("shopId is required");
  // normalizeEmail throws on a shapeless address; the caller validates shape first, but guard here
  // too so a bad address fails visibly rather than minting a link for garbage.
  const normalized = normalizeEmail(email);
  const buyer = await upsertGuestBuyer(shopId, { email: normalized });
  const { raw } = await createMagicLink(shopId, buyer.id);
  const link = `${baseUrl}/storefront/account/login/verify?t=${encodeURIComponent(raw)}`;
  const result = await sendEmail({
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.ORDER_CONFIRM_FROM || process.env.PILOT_FROM || "Calderyn <onboarding@calderyncompany.com>",
    to: normalized,
    subject: "Your sign-in link",
    text: `Use this link to sign in (valid for 15 minutes):\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
  });
  if (!result.sent) {
    console.error(`[buyer-magic-link] failed to send login link for shop ${shopId}: ${result.error ?? "unknown error"}`);
  }
}
