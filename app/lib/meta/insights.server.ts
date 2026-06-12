// Meta Insights fetch (campaign level, daily). Covers Facebook + Instagram —
// both placements bill through the same ad account, so account-level insights
// already include IG spend. A publisher_platform breakdown (FB vs IG) is a
// later/UI concern; Slice 1 only needs per-campaign daily spend.

import { assertNotRateLimited, type MetaClient } from "./campaigns.server";
import { metaInsightToSpend, type MetaInsightRow } from "./transform";
import type { NormalizedSpendRow } from "../ads/adapter";

// Throttle classification lives with MetaResponse in campaigns.server.ts;
// re-exported here so existing importers (ingest, ad-insights) keep working.
export { assertNotRateLimited };

export interface InsightsWindow {
  datePreset?: string; // e.g. "last_90d"
  day?: string; // single YYYY-MM-DD
}

export async function fetchMetaInsights(
  client: MetaClient,
  adAccountId: string,
  shopId: string,
  window: InsightsWindow,
): Promise<NormalizedSpendRow[]> {
  const baseParams: Record<string, string> = {
    level: "campaign",
    time_increment: "1",
    fields: "campaign_id,spend,impressions,clicks,actions,action_values",
    limit: "500",
  };
  if (window.day) {
    baseParams.time_range = JSON.stringify({ since: window.day, until: window.day });
  } else {
    baseParams.date_preset = window.datePreset ?? "last_90d";
  }

  const rows: NormalizedSpendRow[] = [];
  let after: string | undefined;

  do {
    const params = after ? { ...baseParams, after } : baseParams;
    const res = assertNotRateLimited(await client.get(`/${adAccountId}/insights`, params));
    if (res.error) throw new Error(`Meta Insights error: ${res.error.message}`);
    const page = (res.data as MetaInsightRow[]) ?? [];
    for (const r of page) rows.push(metaInsightToSpend(r, shopId));
    const paging = (res as { paging?: { next?: string; cursors?: { after?: string } } }).paging;
    after = paging?.next ? paging.cursors?.after : undefined;
  } while (after);

  return rows;
}
