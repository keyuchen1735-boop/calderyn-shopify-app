// Reconcile order-level attributed revenue into ad_spend_fact.revenue_attrib_cents.
// Order attribution OVERRIDES the platform-reported value (from Slice 1) for any
// (campaign, day) we actually attributed; untouched (campaign, day) rows keep the
// platform-reported number. Revenue is booked to the ORDER's day (v1 simplification).

import type { SupabaseClient } from "@supabase/supabase-js";

export async function reconcileAttributedRevenue(
  shopId: string,
  sb: SupabaseClient,
): Promise<void> {
  const { data: attrRows, error: aErr } = await sb
    .from("attribution_fact")
    .select("campaign_id, order_id, attributed_revenue_cents")
    .eq("shop_id", shopId);
  if (aErr) throw aErr;

  const attributed = (attrRows ?? []).filter(
    (r) => (r as { campaign_id: string | null }).campaign_id,
  ) as Array<{ campaign_id: string; order_id: string; attributed_revenue_cents: number }>;
  if (!attributed.length) return;

  const { data: orderRows, error: oErr } = await sb
    .from("order_fact")
    .select("id, created_at_source")
    .eq("shop_id", shopId)
    .in("id", attributed.map((r) => r.order_id));
  if (oErr) throw oErr;
  const dayByOrder = new Map<string, string>(
    (orderRows ?? []).map((o) => [
      String((o as { id: string }).id),
      String((o as { created_at_source: string }).created_at_source).slice(0, 10),
    ]),
  );

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
    if (uErr) throw uErr;
  }
}
