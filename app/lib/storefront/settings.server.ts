// app/lib/storefront/settings.server.ts
// Brand chrome for the storefront shell, promoted from the hardcoded stub to a per-shop
// store_settings row (first written by the generator). Mirrors page-document.server.ts:
// service-role client, shop_id-scoped, non-uuid (demo) shops skip the DB and get defaults
// so the storefront never blanks.
import { getSupabase } from "~/lib/supabase.server";

export interface StoreSettings {
  shopId: string;
  storeName: string;
  logoUrl: string | null;
  palette: { primary: string; background: string; text: string };
  voiceTagline: string | null;
}
export interface StoreSettingsInput {
  storeName: string;
  palette: StoreSettings["palette"];
  logoUrl: string | null;
  voiceTagline: string | null;
}

export const DEFAULT_PALETTE = { primary: "#0f766e", background: "#ffffff", text: "#111827" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function defaults(shopId: string): StoreSettings {
  return { shopId, storeName: "Calderyn Demo Store", logoUrl: null, palette: DEFAULT_PALETTE, voiceTagline: null };
}

export async function getStoreSettings(shopId: string): Promise<StoreSettings> {
  if (!UUID_RE.test(shopId)) return defaults(shopId);
  const { data, error } = await getSupabase()
    .from("store_settings").select("store_name, palette, logo_url, voice_tagline").eq("shop_id", shopId).maybeSingle();
  if (error) throw error;
  if (!data) return defaults(shopId);
  return {
    shopId,
    storeName: typeof data.store_name === "string" ? data.store_name : "Calderyn Demo Store",
    logoUrl: (data.logo_url as string | null) ?? null,
    palette: (data.palette as StoreSettings["palette"]) ?? DEFAULT_PALETTE,
    voiceTagline: (data.voice_tagline as string | null) ?? null,
  };
}

export async function saveStoreSettings(shopId: string, input: StoreSettingsInput): Promise<void> {
  if (!UUID_RE.test(shopId)) throw new Error(`saveStoreSettings requires a real (uuid) shop_id, got ${shopId}`);
  const { error } = await getSupabase().from("store_settings").upsert(
    { shop_id: shopId, store_name: input.storeName, palette: input.palette, logo_url: input.logoUrl, voice_tagline: input.voiceTagline, updated_at: new Date().toISOString() },
    { onConflict: "shop_id" },
  );
  if (error) throw error;
}
