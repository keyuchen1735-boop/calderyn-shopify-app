// Keep the engine alive: after any owned balance change, append an
// inventory_level_fact observation so detectors read the owned sellable stock.
// variant_id == sku_dim.id (Slice 1 invariant), so sku_id = variantId.
//
// We project on_hand - unavailable (physical stock minus damaged/safety stock),
// NOT raw on_hand: the engine reads inventory_level_fact.available as sellable
// stock, so projecting on_hand would make markUnavailable invisible to the
// engine. Transient reserved holds are deliberately excluded (reserve/release
// don't re-project; a hold is not a permanent stock loss).
import { getSupabase } from "../supabase.server";

export async function projectLevelFact(shopId: string, variantId: string, locationId: string): Promise<void> {
  const sb = getSupabase();
  const { data: bal, error } = await sb
    .from("inventory_balance")
    .select("on_hand, unavailable")
    .eq("shop_id", shopId)
    .eq("variant_id", variantId)
    .eq("location_id", locationId)
    .maybeSingle();
  if (error) throw error;
  if (!bal) return;
  const sellable = Math.max(0, Number(bal.on_hand) - Number(bal.unavailable));
  // Upsert on the (sku_id, location_id, source_version) unique key so two
  // observations of the same pair within one millisecond refresh rather than throw.
  const { error: insErr } = await sb.from("inventory_level_fact").upsert(
    {
      shop_id: shopId, sku_id: variantId, location_id: locationId,
      available: sellable, observed_at: new Date().toISOString(), source_version: Date.now(),
    },
    { onConflict: "sku_id,location_id,source_version" },
  );
  if (insErr) throw insErr;
}
