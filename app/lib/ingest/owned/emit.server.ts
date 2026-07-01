import { getSupabase } from "../../supabase.server";
import { parseOwnedCheckoutCompleted, type OwnedCheckoutCompleted } from "./events";

// The single seam the owned checkout calls after a payment is confirmed. Validates
// the event (rejecting any PII), then inserts it into raw_owned_event for the transform
// loop to pick up. Idempotent: a duplicate event_id is a no-op (checkout may retry).
// Never writes facts directly — the DLQ-backed transform does that.
export async function emitOwnedEvent(event: OwnedCheckoutCompleted): Promise<void> {
  const e = parseOwnedCheckoutCompleted(event); // throws on PII / malformed
  const { error } = await getSupabase()
    .from("raw_owned_event")
    .upsert(
      { shop_id: e.shop_id, event_id: e.event_id, type: e.type, payload: e as unknown as object },
      { onConflict: "shop_id,event_id", ignoreDuplicates: true },
    );
  if (error) throw error;
}
