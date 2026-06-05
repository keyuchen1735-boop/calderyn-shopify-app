import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase is not configured: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.",
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

export async function resolveShopId(shopDomain: string): Promise<string> {
  const cached = shopIdCache.get(shopDomain);
  if (cached) return cached;

  const { data, error } = await getSupabase()
    .from("shops")
    .select("id")
    .eq("shop_domain", shopDomain)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(`Shop not found in Supabase: ${shopDomain}`);
  }
  shopIdCache.set(shopDomain, data.id);
  return data.id;
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
