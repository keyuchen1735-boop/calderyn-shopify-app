// app/lib/storefront/settings.server.ts
// Brand chrome for the storefront shell, promoted from the hardcoded stub to a per-shop
// store_settings row (first written by the generator). Mirrors page-document.server.ts:
// service-role client, shop_id-scoped, non-uuid (demo) shops skip the DB and get defaults
// so the storefront never blanks.
import { getSupabase } from "~/lib/supabase.server";
import type { StudioVibe, StudioTypeStyle, StudioDensity } from "~/lib/storebuilder/studio-types";

export interface StoreSettings {
  shopId: string;
  storeName: string;
  logoUrl: string | null;
  palette: { primary: string; background: string; text: string };
  voiceTagline: string | null;
  /** Design vibe the storefront CSS packs key off ([data-vibe]). */
  vibe: StudioVibe;
  typeStyle: StudioTypeStyle;
  density: StudioDensity;
  /** Hidden Labs switch: chat builds route through the from-scratch designer.
   *  Optional with absence meaning off, so settings fixtures stay untouched. */
  composerEnabled?: boolean;
}
export interface StoreSettingsInput {
  storeName: string;
  palette: StoreSettings["palette"];
  /** Optional: when omitted the stored logo is left untouched — a regenerate
   *  must never wipe a merchant-uploaded logo. Pass null to explicitly clear. */
  logoUrl?: string | null;
  voiceTagline: string | null;
  /** Optional: when omitted the stored vibe is left untouched (new rows take
   *  the column default 'minimal'). */
  vibe?: StudioVibe;
  typeStyle?: StudioTypeStyle;
  density?: StudioDensity;
}

export const DEFAULT_PALETTE = { primary: "#0f766e", background: "#ffffff", text: "#111827" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mirrors the store_settings.vibe check constraint. */
const VIBES: readonly StudioVibe[] = ["minimal", "bold", "warm"];
const TYPE_STYLES: readonly StudioTypeStyle[] = ["classic", "editorial", "rounded"];
const DENSITIES: readonly StudioDensity[] = ["compact", "standard", "roomy"];

function defaults(shopId: string): StoreSettings {
  return { shopId, storeName: "Calderyn Demo Store", logoUrl: null, palette: DEFAULT_PALETTE, voiceTagline: null, vibe: "minimal", typeStyle: "classic", density: "standard" };
}

export async function getStoreSettings(shopId: string): Promise<StoreSettings> {
  if (!UUID_RE.test(shopId)) return defaults(shopId);
  const { data, error } = await getSupabase()
    .from("store_settings").select("store_name, palette, logo_url, voice_tagline, vibe, type_style, density, composer_enabled").eq("shop_id", shopId).maybeSingle();
  if (error) throw error;
  if (!data) {
    // A real shop that hasn't run the store generator yet still has a brand:
    // the display_name it signed up with. Never label a merchant's storefront
    // as the demo store.
    const { data: shop, error: shopError } = await getSupabase()
      .from("shops").select("display_name").eq("id", shopId).maybeSingle();
    if (shopError) throw shopError;
    const displayName = typeof shop?.display_name === "string" ? shop.display_name.trim() : "";
    return { ...defaults(shopId), storeName: displayName || "Your store" };
  }
  return {
    shopId,
    storeName: typeof data.store_name === "string" ? data.store_name : "Calderyn Demo Store",
    logoUrl: (data.logo_url as string | null) ?? null,
    palette: (data.palette as StoreSettings["palette"]) ?? DEFAULT_PALETTE,
    voiceTagline: (data.voice_tagline as string | null) ?? null,
    vibe: VIBES.includes(data.vibe as StudioVibe) ? (data.vibe as StudioVibe) : "minimal",
    typeStyle: TYPE_STYLES.includes(data.type_style as StudioTypeStyle) ? (data.type_style as StudioTypeStyle) : "classic",
    density: DENSITIES.includes(data.density as StudioDensity) ? (data.density as StudioDensity) : "standard",
    composerEnabled: data.composer_enabled === true,
  };
}

/** Flip the hidden designer-engine switch. Upserts so shops that never ran the
 *  generator (no store_settings row yet) can still opt in from Labs. */
export async function setComposerEnabled(shopId: string, enabled: boolean): Promise<void> {
  if (!UUID_RE.test(shopId)) throw new Error(`setComposerEnabled requires a real (uuid) shop_id, got ${shopId}`);
  const current = await getStoreSettings(shopId);
  const { error } = await getSupabase().from("store_settings").upsert({
    shop_id: shopId,
    store_name: current.storeName,
    palette: current.palette,
    voice_tagline: current.voiceTagline,
    composer_enabled: enabled,
    updated_at: new Date().toISOString(),
  }, { onConflict: "shop_id" });
  if (error) throw error;
}

/** Whether a shop has ever written a store_settings row — lets callers avoid
 *  clobbering a merchant-set vibe on a re-generation (non-uuid shopIds never
 *  have a row). */
export async function hasStoreSettings(shopId: string): Promise<boolean> {
  if (!UUID_RE.test(shopId)) return false;
  const { data, error } = await getSupabase()
    .from("store_settings").select("shop_id").eq("shop_id", shopId).maybeSingle();
  if (error) throw error;
  return data != null;
}

export async function saveStoreSettings(shopId: string, input: StoreSettingsInput): Promise<void> {
  if (!UUID_RE.test(shopId)) throw new Error(`saveStoreSettings requires a real (uuid) shop_id, got ${shopId}`);
  const row: Record<string, unknown> = {
    shop_id: shopId, store_name: input.storeName, palette: input.palette, voice_tagline: input.voiceTagline, updated_at: new Date().toISOString(),
  };
  // Omitted logo/vibe leaves the stored value untouched (upsert only writes the
  // columns present in the payload); new rows take the column default.
  if (input.logoUrl !== undefined) row.logo_url = input.logoUrl;
  if (input.vibe !== undefined) row.vibe = input.vibe;
  if (input.typeStyle !== undefined) row.type_style = input.typeStyle;
  if (input.density !== undefined) row.density = input.density;
  const { error } = await getSupabase().from("store_settings").upsert(row, { onConflict: "shop_id" });
  if (error) throw error;
}
