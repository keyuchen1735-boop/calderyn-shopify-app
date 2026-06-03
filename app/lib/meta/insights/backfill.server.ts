import { getSupabase, resolveShopId } from "../../supabase.server";
import { metaClientForShop } from "../client.server";
import { writeDlq } from "../../ingest/dlq.server";
import type { MetaClient } from "../campaigns.server";
import { fetchInsights, type InsightsQuery } from "./insights-client.server";
import type { InsightRow } from "./mappers.server";
import { mapCampaignInsight, mapAdInsight, mapAdDim, mapCampaignDim } from "./mappers.server";

export const BACKFILL_DAYS = 90;

export interface BackfillDeps {
  shopId: string;
  adAccountId: string;
  client: MetaClient;
  fetchInsights: (c: MetaClient, acct: string, q: InsightsQuery) => Promise<InsightRow[]>;
  upsert: (table: string, rows: unknown[]) => Promise<void>;
  now: Date;
}

export interface BackfillResult {
  campaignFacts: number;
  adFacts: number;
}

/** Pure: YYYY-MM-DD since/until window of `days`, inclusive, ending on `now`. */
export function windowRange(days: number, now: Date): { since: string; until: string } {
  const until = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  return { since, until };
}

function dedupeByExternalId<T extends { external_id: string }>(rows: T[]): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(r.external_id, r);
  return [...m.values()];
}

/** Orchestrate one shop's backfill with injected deps (unit-testable). */
export async function backfillMetaShop(deps: BackfillDeps): Promise<BackfillResult> {
  const { since, until } = windowRange(BACKFILL_DAYS, deps.now);

  const campaignRows = await deps.fetchInsights(deps.client, deps.adAccountId, { level: "campaign", since, until });
  const campaignDims = dedupeByExternalId(campaignRows.map((r) => mapCampaignDim(deps.shopId, r)));
  const campaignFacts = campaignRows.map((r) => mapCampaignInsight(deps.shopId, r));
  if (campaignDims.length) await deps.upsert("ad_campaign_dim", campaignDims);
  if (campaignFacts.length) await deps.upsert("ad_spend_fact", campaignFacts);

  const adRows = await deps.fetchInsights(deps.client, deps.adAccountId, { level: "ad", since, until });
  const adDims = dedupeByExternalId(adRows.map((r) => mapAdDim(deps.shopId, r)));
  const adFacts = adRows.map((r) => mapAdInsight(deps.shopId, r));
  if (adDims.length) await deps.upsert("ad_dim", adDims);
  if (adFacts.length) await deps.upsert("ad_insight_fact", adFacts);

  return { campaignFacts: campaignFacts.length, adFacts: adFacts.length };
}

const CONFLICT: Record<string, string> = {
  ad_campaign_dim: "shop_id,external_id",
  ad_dim: "shop_id,external_id",
  ad_spend_fact: "shop_id,campaign_external_id,day_bucket",
  ad_insight_fact: "shop_id,ad_external_id,day_bucket",
};

/** Production entry: resolves creds + supabase, delegates to backfillMetaShop. */
export async function runMetaBackfill(shopDomain: string): Promise<BackfillResult> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shopDomain);
  const conn = await metaClientForShop(shopDomain);
  if (!conn) return { campaignFacts: 0, adFacts: 0 };

  try {
    const res = await backfillMetaShop({
      shopId,
      adAccountId: conn.adAccountId,
      client: conn.client,
      fetchInsights,
      now: new Date(),
      upsert: async (table, rows) => {
        const { error } = await sb.from(table).upsert(rows as object[], { onConflict: CONFLICT[table] });
        if (error) throw error;
      },
    });
    await sb
      .from("shop_integrations")
      .update({ sync_status: "ready", sync_error: null, last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("shop_id", shopId)
      .eq("kind", "meta_ads");
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeDlq({ shopId, connector: "meta", jobKind: "backfill", errorKind: "backfill_failed", errorMessage: message, payload: { shopDomain } });
    await sb
      .from("shop_integrations")
      .update({ sync_status: "error", sync_error: message.slice(0, 500), updated_at: new Date().toISOString() })
      .eq("shop_id", shopId)
      .eq("kind", "meta_ads");
    throw err;
  }
}
