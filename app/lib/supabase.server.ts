import { createHmac } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ActionKind } from "./types";
import { NO_BRAINER, pairConfidence } from "./calibration/confidence";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  // Prefer the modern secret key (sb_secret_...); fall back to the legacy
  // service_role JWT. Both are server-only, full-access keys that bypass RLS, so
  // this is a drop-in. Legacy keys are being phased out by Supabase, so the
  // secret key takes precedence when present.
  const serviceRoleKey =
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase is not configured: SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) must be set.",
    );
  }

  _client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" },
  });
  return _client;
}

// shop_domain → shop id is immutable (provisionShop upserts the row and only
// toggles uninstalled_at; the id is never reassigned). Memoize it per process so
// every loader avoids a redundant cross-region round trip to look it up. The
// cache resets on cold start, which is fine — it's only a latency optimization.
const shopIdCache = new Map<string, string>();

// A shops.id (UUID) may be passed directly: owned (first-party) shops have no
// shop_domain, so the dashboard resolves tenancy by the universal shop id. A
// domain never matches this shape, so existing domain lookups are unaffected.
const SHOP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveShopId(shopOrId: string): Promise<string> {
  if (SHOP_ID_RE.test(shopOrId)) return shopOrId;
  const cached = shopIdCache.get(shopOrId);
  if (cached) return cached;

  const { data, error } = await getSupabase()
    .from("shops")
    .select("id")
    .eq("shop_domain", shopOrId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(`Shop not found in Supabase: ${shopOrId}`);
  }
  shopIdCache.set(shopOrId, data.id);
  return data.id;
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

// Mint a short-lived HS256 JWT that authorizes PostgREST to SET ROLE app_web —
// the NON-bypass tenant read lane. Signed with the project JWT secret (server
// only), so it is a valid project token. `shop_id` is carried as a claim (see
// getTenantSupabase for why it is advisory today, not the enforcement key).
function mintAppWebJwt(shopId: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ role: "app_web", shop_id: shopId, iss: "calderyn-tenant-lane", iat: now, exp: now + 3600 }),
  );
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * NON-service-role tenant read lane (Step 10 RLS enforcement).
 *
 * Returns a Supabase client authenticated as the `app_web` Postgres role
 * (NOBYPASSRLS, SELECT-only on tenant tables) — NOT the service-role client from
 * getSupabase(). Use it where you want the database, not a hand-written
 * `.eq('shop_id')`, to enforce tenant isolation.
 *
 * ENFORCEMENT MODEL — read before adopting. RLS policies key off
 * `current_shop_id()` = the `app.shop_id` session GUC. PostgREST pools
 * connections and runs each REST call in its own transaction, so a plain
 * `.from(...).select()` on this lane cannot set app.shop_id for its own
 * statement: current_shop_id() is null, every policy fails, and the query
 * returns ZERO rows. That is fail-closed — this lane never returns cross-tenant
 * data — but plain selects are not yet useful.
 *
 * The supported enforcement path is a tenant-scoped SECURITY INVOKER RPC that
 * sets the GUC transaction-locally and runs its query in the same call, e.g.:
 *   create function read_x(p_shop uuid) returns setof x security invoker as $$
 *     select set_config('app.shop_id', p_shop::text, true);
 *     select * from x;            -- RLS binds current_shop_id() = p_shop
 *   $$ language sql;
 * invoked as `getTenantSupabase(shopId).rpc('read_x', { p_shop: shopId })`.
 * Because app_web is NOBYPASSRLS, the database filters cross-tenant rows.
 *
 * Live reads stay on getSupabase() (service-role) until such RPCs exist; this is
 * the additive adoption seam, not a cutover. shop_id rides as a JWT claim for
 * audit and as the single place enforcement would activate if current_shop_id()
 * ever gains a request.jwt.claims fallback.
 *
 * Requires SUPABASE_URL + SUPABASE_JWT_SECRET; uses SUPABASE_PUBLISHABLE_KEY as
 * the gateway apikey when present.
 */
export function getTenantSupabase(shopId: string): SupabaseClient {
  if (!SHOP_ID_RE.test(shopId)) {
    throw new Error(`getTenantSupabase requires a shops.id UUID, got: ${shopId}`);
  }
  const url = process.env.SUPABASE_URL;
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!url || !jwtSecret) {
    throw new Error(
      "Tenant lane not configured: SUPABASE_URL and SUPABASE_JWT_SECRET must be set.",
    );
  }
  const token = mintAppWebJwt(shopId, jwtSecret);
  const apiKey = process.env.SUPABASE_PUBLISHABLE_KEY || token;
  return createClient(url, apiKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/**
 * Ensure a shops row exists for this domain. Idempotent.
 * If the shop was previously uninstalled, reactivate it (clear uninstalled_at,
 * bump updated_at) — guarded so routine token-exchanges don't churn updated_at.
 */
export async function provisionShop(shopDomain: string): Promise<void> {
  const sb = getSupabase();
  const ins = await sb
    .from("shops")
    .upsert({ shop_domain: shopDomain }, { onConflict: "shop_domain", ignoreDuplicates: true });
  if (ins.error) throw ins.error;

  const react = await sb
    .from("shops")
    .update({ uninstalled_at: null, updated_at: new Date().toISOString() })
    .eq("shop_domain", shopDomain)
    .not("uninstalled_at", "is", null);
  if (react.error) throw react.error;

  const { data: shop, error: shopError } = await sb
    .from("shops")
    .select("id")
    .eq("shop_domain", shopDomain)
    .maybeSingle();
  if (shopError) throw shopError;
  if (!shop?.id) throw new Error(`Provisioned shop row could not be resolved: ${shopDomain}`);

  shopIdCache.set(shopDomain, shop.id);
  await seedShippedAutopilotFeatures(shop.id, sb);
}

/**
 * Ensure Calderyn's three baseline no-brainer features exist for a shop.
 * Existing rows are left untouched so merchant off-switches and learned state
 * survive re-authentication. A migration performs the corresponding backfill
 * for shops that already existed when this behavior shipped.
 */
export async function seedShippedAutopilotFeatures(
  shopId: string,
  sb: SupabaseClient,
): Promise<void> {
  const rows = [...NO_BRAINER].map((key) => {
    const [detectorId, rawActionKind] = key.split(":");
    const actionKind = rawActionKind as ActionKind;
    return {
      shop_id: shopId,
      detector_id: detectorId,
      action_kind: actionKind,
      graduated: true,
      last_conf: pairConfidence(detectorId, actionKind, { alpha: 0, beta: 0 }, null),
    };
  });
  const { error } = await sb
    .from("pair_calibration")
    .upsert(rows, {
      onConflict: "shop_id,detector_id,action_kind",
      ignoreDuplicates: true,
    });
  if (error) throw error;
}

/** Soft-mark a shop uninstalled (inverse of provisionShop's reactivation). */
export async function markShopUninstalled(shopDomain: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await getSupabase()
    .from("shops")
    .update({ uninstalled_at: now, updated_at: now })
    .eq("shop_domain", shopDomain);
  if (error) throw error;
}
