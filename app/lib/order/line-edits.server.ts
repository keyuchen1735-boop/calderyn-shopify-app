// app/lib/order/line-edits.server.ts
// Shared read model for a native order's EFFECTIVE line quantities (orders phase 3, Task 3).
// `order_line` rows are the immutable time-of-sale snapshot (never mutated by an edit); every
// reduction is an append-only `order_line_edit` row instead. Three read sites need the resulting
// "what does this line actually total now" number without re-deriving it three different ways:
// detail.server.ts (line list + timeline), fulfill.server.ts (remaining-to-ship), and — by
// deliberate CONTRAST — emit.server.ts, which does NOT call this (see its module comment): a
// warehouse fact row is a time-of-sale record, so it stays on the snapshot forever; a reduction
// is a refund_fact, not a fact rewrite.
//
// order_line_edit rows CHAIN: each edit's old_quantity is the quantity that was effective
// immediately before it (which may itself be a prior edit's new_quantity, not the original
// snapshot). So the line's CURRENT effective quantity is NOT a running sum of deltas — it is
// simply the new_quantity of the MOST RECENT edit for that line. Two edits on the same line
// (5 -> 3, then 3 -> 1) leave exactly one "current" value: 1, with the second edit's old_quantity
// (3) matching the first edit's new_quantity, not the original snapshot (5).
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "~/lib/supabase.server";

export interface LineQuantities {
  /** The immutable order_line.quantity at time of sale — never changes after checkout. */
  snapshot: number;
  /** snapshot - effective: total units reduced off this line across every edit. 0 if unedited. */
  reduced: number;
  /** The quantity that actually counts today: the latest edit's new_quantity, or the snapshot
   *  when the line has never been edited. */
  effective: number;
}

interface EditRow {
  order_line_id: string;
  new_quantity: number;
  created_at: string;
  id: string;
}

/**
 * Every native order_line on `orderId`, keyed by line id, with its snapshot/reduced/effective
 * quantities. A line absent from the returned map does not exist on this order for this shop.
 */
export async function effectiveLineQuantities(
  shopId: string,
  orderId: string,
  sb: SupabaseClient = getSupabase(),
): Promise<Map<string, LineQuantities>> {
  if (!shopId) throw new Error("shopId is required");
  if (!orderId) throw new Error("orderId is required");

  const linesRes = await sb.from("order_line").select("id, quantity").eq("shop_id", shopId).eq("order_id", orderId);
  if (linesRes.error) throw new Error(`order_line read failed: ${linesRes.error.message}`);
  const lines = (linesRes.data ?? []) as Array<{ id: string; quantity: number }>;

  const editsRes = await sb
    .from("order_line_edit")
    .select("order_line_id, new_quantity, created_at, id")
    .eq("shop_id", shopId)
    .eq("order_id", orderId);
  if (editsRes.error) throw new Error(`order_line_edit read failed: ${editsRes.error.message}`);
  const edits = (editsRes.data ?? []) as EditRow[];

  // Latest edit per line: created_at desc, id (uuid string) as the tiebreak for two edits landing
  // in the same instant — deterministic, not "whichever the query happened to return last."
  const latestByLine = new Map<string, EditRow>();
  for (const edit of edits) {
    const lineId = String(edit.order_line_id);
    const current = latestByLine.get(lineId);
    if (
      !current ||
      edit.created_at > current.created_at ||
      (edit.created_at === current.created_at && String(edit.id) > String(current.id))
    ) {
      latestByLine.set(lineId, edit);
    }
  }

  const result = new Map<string, LineQuantities>();
  for (const line of lines) {
    const id = String(line.id);
    const snapshot = Number(line.quantity);
    const latest = latestByLine.get(id);
    const effective = latest ? Number(latest.new_quantity) : snapshot;
    result.set(id, { snapshot, reduced: snapshot - effective, effective });
  }
  return result;
}
