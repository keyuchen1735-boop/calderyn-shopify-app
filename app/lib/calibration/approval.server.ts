// Records a merchant approval as the positive learning signal for a
// (detector, action) pair. Atomic via the calibration_record_approval SQL fn.
// Never throws: the action it follows has already succeeded, so a bump failure
// must not surface as an action failure (it is logged and the next nightly
// recompute self-heals from the append-only audit anyway).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionKind } from "../types";

export async function recordApproval(
  shopId: string,
  detectorId: string,
  actionKind: ActionKind,
  sb: SupabaseClient,
): Promise<void> {
  try {
    const { error } = await sb.rpc("calibration_record_approval", {
      p_shop_id: shopId,
      p_detector_id: detectorId,
      p_action_kind: actionKind,
    });
    if (error) console.error(`[calibration] recordApproval failed: ${error.message}`);
  } catch (err) {
    console.error(`[calibration] recordApproval threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}
