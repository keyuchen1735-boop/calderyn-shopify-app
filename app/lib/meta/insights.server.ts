// Meta Insights fetch (campaign level, daily). Covers Facebook + Instagram —
// both placements bill through the same ad account, so account-level insights
// already include IG spend. A publisher_platform breakdown (FB vs IG) is a
// later/UI concern; Slice 1 only needs per-campaign daily spend.

import type { MetaClient, MetaResponse } from "./campaigns.server";
import { metaInsightToSpend, type MetaInsightRow } from "./transform";
import type { NormalizedSpendRow } from "../ads/adapter";
import { RateLimitError } from "../ads/backoff";

const META_RATE_CODES = new Set([4, 17, 32, 613]); // app/user/account rate limits

/** Throw RateLimitError on a Meta throttle so withRetry can back off. */
export function assertNotRateLimited(r: MetaResponse): MetaResponse {
  const code = r.error?.code;
  if (code !== undefined && META_RATE_CODES.has(code)) {
    throw new RateLimitError(`Meta rate limit (code ${code})`);
  }
  return r;
}

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
