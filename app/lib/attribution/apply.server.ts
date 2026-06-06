// Resolve one order to a campaign and persist the result. Writes exactly one
// attribution_fact row (campaign_id null for platform-level/unknown) and one
// ad_click_ref row per captured click-id. Called from the ingest transform
// after order_fact is upserted.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AttributionSignals, CampaignRef, ClickIdKind } from "./types";
import { resolveAttribution } from "./match";
import { clickIdPlatform } from "./parse";

const CLICK_KEYS: ClickIdKind[] = ["fbclid", "gclid", "ttclid"];

export async function applyAttribution(
  shopId: string,
  orderId: string,
  revenueCents: number,
  signals: AttributionSignals,
  sb: SupabaseClient,
): Promise<void> {
  const { data: campRows, error: cErr } = await sb
    .from("ad_campaign_dim")
    .select("id, external_id, name, platform")
    .eq("shop_id", shopId);
  if (cErr) throw cErr;
  const campaigns = (campRows ?? []) as CampaignRef[];

  const result = resolveAttribution(signals, campaigns);

  // One attribution row per order. Delete-then-insert (rather than upsert) is the
  // idempotent, reprocessing-safe write here: the matcher yields exactly one
  // result per order, and ON CONFLICT cannot target the partial unique index that
  // guards the campaign_id-null (unattributed) case. The transform runs orders
  // sequentially, so there is no concurrent writer for the same order_id.
  const { error: dErr } = await sb
    .from("attribution_fact")
    .delete()
    .eq("shop_id", shopId)
    .eq("order_id", orderId);
  if (dErr) throw dErr;

  const { error: aErr } = await sb.from("attribution_fact").insert({
    shop_id: shopId,
    order_id: orderId,
    campaign_id: result.campaignId,
    platform: result.platform,
    attributed_revenue_cents: result.campaignId ? revenueCents : 0,
    attribution_method: result.method,
    confidence: result.confidence,
  });
  if (aErr) throw aErr;

  // Persist captured click-ids (one upsert per click-id). Keyed (order_id, platform, click_id).
  for (const kind of CLICK_KEYS) {
    const value = signals.clickIds[kind];
    if (!value) continue;
    const { error: clErr } = await sb
      .from("ad_click_ref")
      .upsert(
        {
          shop_id: shopId,
          order_id: orderId,
          platform: clickIdPlatform(kind),
          click_id: value,
          utm: signals.utm,
        },
        { onConflict: "order_id,platform,click_id" },
      );
    if (clErr) throw clErr;
  }
}
