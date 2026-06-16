// Reconcile order-level attributed revenue into ad_spend_fact.revenue_attrib_cents.
// Order attribution OVERRIDES the platform-reported value (from Slice 1) for any
// (campaign, day) we actually attributed; untouched (campaign, day) rows keep the
// platform-reported number. Revenue is booked to the ORDER's day (v1 simplification).

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

// Max order_ids per order_fact `.in("id", [...])` read. supabase-js sends reads
// as GET with filters in the URL, so an unbounded list (a shop with thousands of
// attributed orders) overflows the request-URI limit (414 / fetch failure). At
// ~38 bytes/uuid this keeps each request well under ~8KB of filter.
export const ORDER_ID_BATCH = 200;

// Turn a PostgREST/Supabase `{ message, details, hint, code }` object into a real
// Error with a readable message. Throwing the raw object propagates a non-Error
// that String()s to "[object Object]" at the call site.
function asError(err: PostgrestError | null, context: string): Error {
  const parts = [err?.message, err?.details, err?.code && `code=${err.code}`].filter(Boolean);
  return new Error(`${context}: ${parts.join(" ") || "unknown Supabase error"}`);
}

export async function reconcileAttributedRevenue(
  shopId: string,
  sb: SupabaseClient,
): Promise<void> {
  const { data: attrRows, error: aErr } = await sb
    .from("attribution_fact")
    .select("campaign_id, order_id, attributed_revenue_cents")
    .eq("shop_id", shopId);
  if (aErr) throw asError(aErr, `attribution_fact read failed for shop ${shopId}`);

  const attributed = (attrRows ?? []).filter(
    (r) => (r as { campaign_id: string | null }).campaign_id,
  ) as Array<{ campaign_id: string; order_id: string; attributed_revenue_cents: number }>;
  if (!attributed.length) return;

  // Resolve each attributed order's booking day. Batch the id lookup: a single
  // unbounded `.in()` builds a GET URL that overflows the request-URI limit for
  // shops with thousands of orders (the latent "[object Object]" cron failure).
  const orderIds = [...new Set(attributed.map((r) => r.order_id))];
  const dayByOrder = new Map<string, string>();
  for (let i = 0; i < orderIds.length; i += ORDER_ID_BATCH) {
    const batch = orderIds.slice(i, i + ORDER_ID_BATCH);
    const { data: orderRows, error: oErr } = await sb
      .from("order_fact")
      .select("id, created_at_source")
      .eq("shop_id", shopId)
      .in("id", batch);
    if (oErr) throw asError(oErr, `order_fact read failed for shop ${shopId}`);
    for (const o of orderRows ?? []) {
      dayByOrder.set(
        String((o as { id: string }).id),
        String((o as { created_at_source: string }).created_at_source).slice(0, 10),
      );
    }
  }

  // Sum per (campaign_id, day).
  const sums = new Map<string, { campaignId: string; day: string; cents: number }>();
  for (const r of attributed) {
    const day = dayByOrder.get(r.order_id);
    if (!day) continue;
    const key = `${r.campaign_id}|${day}`;
    const acc = sums.get(key) ?? { campaignId: r.campaign_id, day, cents: 0 };
    acc.cents += Number(r.attributed_revenue_cents ?? 0);
    sums.set(key, acc);
  }

  for (const { campaignId, day, cents } of sums.values()) {
    // shop_id scope on the write: the service-role client bypasses RLS, so
    // the tenant filter is the only cross-shop guard (same convention as the
    // reads above).
    const { error: uErr } = await sb
      .from("ad_spend_fact")
      .update({ revenue_attrib_cents: cents })
      .eq("shop_id", shopId)
      .eq("campaign_id", campaignId)
      .eq("day", day);
    if (uErr) throw asError(uErr, `ad_spend_fact update failed for shop ${shopId}`);
  }
}
