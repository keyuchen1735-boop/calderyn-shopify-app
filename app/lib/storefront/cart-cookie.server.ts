// app/lib/storefront/cart-cookie.server.ts
// Buyer cart cookie for the public storefront (platform pivot #2c-1). Server-only:
// the cookie carries ONLY an opaque cart_id (uuid) — no PII (PII capture is #2c-2).
//
// Signed with SHOPIFY_API_SECRET, the app's existing master secret — no new
// plaintext secret is introduced (CLAUDE.md secret-storage rule). Signing is
// tamper-resistance, not confidentiality: every server-side cart read is still
// scoped by shop_id, and the cart_line composite FK (shop_id, cart_id) rejects a
// forged id that points at another tenant's cart. The cookie is built lazily so
// the secret is read per request (mirrors cookieKey() in lib/mcp_oauth.server.ts),
// keeping the public store renderable even before env is fully wired.
import { createCookie } from "@remix-run/node";

const COOKIE_NAME = "cd_cart";
const MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

function cartCookie() {
  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  return createCookie(COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE_SEC,
    // Sign when the app secret is present; absent only in an unconfigured shell.
    secrets: secret ? [secret] : [],
  });
}

/** Read the cart_id from the signed cookie, or null when absent/invalid. */
export async function readCartId(request: Request): Promise<string | null> {
  const value = await cartCookie().parse(request.headers.get("Cookie"));
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Serialize a Set-Cookie that persists the cart_id signed with the app secret. */
export async function commitCartId(cartId: string): Promise<string> {
  return cartCookie().serialize(cartId);
}

/**
 * Serialize an expiring Set-Cookie that clears the cart cookie (#2c-2): emitted on the order
 * confirmation page so a placed order starts the buyer fresh. maxAge:0 tells the browser to
 * delete the cookie immediately; the empty value also reads back as "no cart" (readCartId treats
 * an empty string as absent) for any client that ignores the expiry.
 */
export async function clearCartId(): Promise<string> {
  return cartCookie().serialize("", { maxAge: 0 });
}
