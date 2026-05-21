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

export async function resolveShopId(shopDomain: string): Promise<string> {
  const { data, error } = await getSupabase()
    .from("shops")
    .select("id")
    .eq("shop_domain", shopDomain)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(`Shop not found in Supabase: ${shopDomain}`);
  }
  return data.id;
}
