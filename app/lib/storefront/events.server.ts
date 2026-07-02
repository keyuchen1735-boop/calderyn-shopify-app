// app/lib/storefront/events.server.ts
// Live-analytics event emitter for the owned storefront (spec
// 2026-07-02-analytics-live-view-design.md). Awaited for serverless safety but
// failure-isolated: a failed insert logs and never blocks a buyer-facing
// render (rule 12: visible in logs, invisible to the buyer). No PII: opaque
// ids + coarse Vercel geo only. The user-agent is checked for bots, never stored.
import { getSupabase } from "../supabase.server";
import { isUuid } from "../ids";
import { ensureVisitorSession, type VisitorSession } from "./visitor-cookie.server";

// Deliberate simplification: naive UA screen; upgrade to real bot scoring
// only if the numbers skew.
const BOT_UA_RE = /bot|crawler|spider|crawling|preview|headless|lighthouse|slurp|curl\b/i;

export type StorefrontEventType =
  | "page_view"
  | "cart_add"
  | "checkout_start"
  | "checkout_complete";

/**
 * Record one storefront event and return the visitor/session Set-Cookie
 * headers the caller must attach to its response. Cookies are always
 * returned — even when the emit is skipped (demo tenant, bot) or fails.
 */
export async function trackStorefrontEvent(
  request: Request,
  shopId: string,
  type: StorefrontEventType,
  opts: { productId?: string | null } = {},
): Promise<Headers> {
  const session = await ensureVisitorSession(request);
  await insertEvent(request, shopId, type, session, opts.productId ?? null);
  return session.headers;
}

async function insertEvent(
  request: Request,
  shopId: string,
  type: StorefrontEventType,
  s: VisitorSession,
  productId: string | null,
): Promise<void> {
  try {
    // Fixture tenants (resolveStorefrontShop's "demo-shop") never reach the DB.
    if (!isUuid(shopId)) return;
    const ua = request.headers.get("user-agent") ?? "";
    if (BOT_UA_RE.test(ua)) return;
    const { error } = await getSupabase().from("storefront_event").insert({
      shop_id: shopId,
      session_id: s.sessionId,
      visitor_id: s.visitorId,
      is_returning: s.isReturning,
      type,
      path: new URL(request.url).pathname,
      product_id: productId,
      country: request.headers.get("x-vercel-ip-country"),
      city: request.headers.get("x-vercel-ip-city"),
    });
    if (error) throw error;
  } catch (err) {
    console.error("[storefront_event] emit failed", err);
  }
}
