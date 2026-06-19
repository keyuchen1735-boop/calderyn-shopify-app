// D5 consume seam (spec §7). Read the learned aggressiveness dial mu for
// (shop, detector, action). Resolve the pseudonym from moat_keys.shop_pseudonym
// (do NOT re-implement pseudonym_for in TS). Missing pseudonym/model -> null ->
// caller uses the full merchant cap (today's behavior). The guardrail is always
// the hard ceiling; mu only scales within it.
import type { SupabaseClient } from "@supabase/supabase-js";

export async function getActionPolicy(
  sb: SupabaseClient, shopId: string, detectorId: string, actionKind: string,
): Promise<number | null> {
  const { data: key } = await sb
    .schema("moat_keys").from("shop_pseudonym")
    .select("pseudonym_id").eq("shop_id", shopId).maybeSingle();
  if (!key?.pseudonym_id) return null;
  const { data: model } = await sb
    .schema("moat").from("action_models")
    .select("policy_json")
    .eq("shop_id_pseudonym", String(key.pseudonym_id))
    .eq("detector_id", detectorId).eq("action_kind", actionKind).maybeSingle();
  const mu = (model?.policy_json as { mu?: number } | undefined)?.mu;
  return typeof mu === "number" ? mu : null;
}
