import { getSupabase, resolveShopId } from "../../supabase.server";
import { metaClientForShop } from "../client.server";
import { writeDlq } from "../../ingest/dlq.server";
import { fetchInsights } from "./insights-client.server";
import { backfillMetaShop, type BackfillResult } from "./backfill.server";

/** Pure: yesterday..today window (covers late-attributed conversions). */
export function pollWindow(now: Date): { since: string; until: string } {
  const until = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - 1 * 86_400_000).toISOString().slice(0, 10);
  return { since, until };
}

const CONFLICT: Record<string, string> = {
  ad_campaign_dim: "shop_id,external_id",
  ad_dim: "shop_id,external_id",
  ad_spend_fact: "shop_id,campaign_external_id,day_bucket",
  ad_insight_fact: "shop_id,ad_external_id,day_bucket",
};

export async function runMetaPoll(shopDomain: string): Promise<BackfillResult> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shopDomain);
  const conn = await metaClientForShop(shopDomain);
  if (!conn) return { campaignFacts: 0, adFacts: 0 };

  const now = new Date();
  const { since, until } = pollWindow(now);
  try {
    // Reuse the backfill orchestration but constrain the window to 2 days.
    const res = await backfillMetaShop({
      shopId,
      adAccountId: conn.adAccountId,
      client: conn.client,
      now,
      fetchInsights: (c, a, q) => fetchInsights(c, a, { ...q, since, until }),
      upsert: async (table, rows) => {
        const { error } = await sb.from(table).upsert(rows as object[], { onConflict: CONFLICT[table] });
        if (error) throw error;
      },
    });
    await sb
      .from("shop_integrations")
      .update({ last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("shop_id", shopId)
      .eq("kind", "meta_ads");
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeDlq({ shopId, connector: "meta", jobKind: "poll", errorKind: "poll_failed", errorMessage: message, payload: { shopDomain } });
    throw err;
  }
}
