import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * After a successful action, move the alert out of the open queue. Flips
 * open → acknowledged; the detector still owns resolution and may re-open it
 * on the next pass. Also matches 'snoozed' so a snooze that re-surfaced via the
 * +1-day cap (raw status still 'snoozed', shown as 'open' by v_alerts_view) can
 * actually be closed — otherwise the update would match no rows yet return true,
 * leaving the alert stuck visible. Returns false (and logs) on failure so the
 * caller can surface it without failing the already-executed action.
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
      .in("status", ["open", "snoozed"]);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`[alerts] failed to acknowledge ${alertId} after action`, err);
    return false;
  }
}
