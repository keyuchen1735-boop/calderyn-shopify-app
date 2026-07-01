import { getSupabase } from "../../supabase.server";
import { writeDlq } from "../dlq.server";
import { applyOwnedOrder } from "./apply.server";
import { parseOwnedCheckoutCompleted, OWNED_CHECKOUT_COMPLETED } from "./events";

const BATCH = 200;

export type OwnedTransformResult = { processed: number; facts: number; dlq: number };

// Owned-event sibling of transformPendingWebhooks. Separate intake table + loop so a
// native CHECKOUT_COMPLETED can never be dispatched by the Shopify topic branch (the
// parent spec's topic-collision guard). DLQ-backed and processed_at-stamped so a poison
// event never loops.
export async function transformPendingOwnedEvents(): Promise<OwnedTransformResult> {
  const sb = getSupabase();
  const res: OwnedTransformResult = { processed: 0, facts: 0, dlq: 0 };

  const { data: rows, error } = await sb
    .from("raw_owned_event")
    .select("id, shop_id, type, payload")
    .is("processed_at", null)
    .order("received_at", { ascending: true })
    .limit(BATCH);
  if (error) throw error;

  for (const row of rows ?? []) {
    try {
      if (row.type === OWNED_CHECKOUT_COMPLETED) {
        const event = parseOwnedCheckoutCompleted(row.payload);
        res.facts += await applyOwnedOrder(event);
      } else {
        // Unexpected type — stamp it so it doesn't loop, but stay visible (rule 12).
        console.warn(`[ingest] owned transform: skipping unhandled event type ${row.type}`);
      }
      await sb.from("raw_owned_event").update({ processed_at: new Date().toISOString() }).eq("id", row.id);
      res.processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await writeDlq({
        shopId: row.shop_id,
        jobKind: `owned_transform:${row.type}`,
        errorKind: "owned_transform_failed",
        errorMessage: message,
        payload: row.payload,
      });
      await sb.from("raw_owned_event").update({ processed_at: new Date().toISOString() }).eq("id", row.id);
      res.dlq += 1;
    }
  }
  return res;
}
