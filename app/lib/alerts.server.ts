import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * After a successful action, move the alert out of the open queue. Only flips
 * open → acknowledged; the detector still owns resolution and may re-open it
 * on the next pass. Returns false (and logs) on failure so the caller can
 * surface it without failing the already-executed action.
 */
export async function acknowledgeAlert(
  sb: SupabaseClient,
  shopId: string,
  alertId: string,
): Promise<boolean> {
  try {
    const { error } = await sb
      .from("alerts")
      .update({ status: "acknowledged" })
      .eq("shop_id", shopId)
      .eq("id", alertId)
      .eq("status", "open");
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`[alerts] failed to acknowledge ${alertId} after action`, err);
    return false;
  }
}
