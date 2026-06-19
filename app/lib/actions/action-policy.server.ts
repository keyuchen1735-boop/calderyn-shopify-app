// D5 consume seam (spec §7). Read the learned aggressiveness dial mu for
// (shop, detector, action) via the public SECURITY DEFINER function
// `autopilot_action_mu`, which resolves the shop's pseudonym and reads
// moat.action_models internally. This keeps the anonymized moat/moat_keys schemas
// OFF PostgREST (service_role gets EXECUTE on one function, not broad moat read).
// Any error or missing model -> null -> caller uses the full merchant cap (today's
// behavior). The guardrail is always the hard ceiling; mu only scales within it.
import type { SupabaseClient } from "@supabase/supabase-js";

export async function getActionPolicy(
  sb: SupabaseClient,
  shopId: string,
  detectorId: string,
  actionKind: string,
): Promise<number | null> {
  const { data, error } = await sb.rpc("autopilot_action_mu", {
    p_shop_id: shopId,
    p_detector_id: detectorId,
    p_action_kind: actionKind,
  });
  if (error || data == null) return null;
  const mu = Number(data); // numeric comes back as number | string
  return Number.isFinite(mu) ? mu : null;
}
