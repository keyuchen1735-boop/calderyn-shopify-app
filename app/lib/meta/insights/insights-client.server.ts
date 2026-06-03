import type { MetaClient, MetaResponse } from "../campaigns.server";
import type { InsightRow } from "./mappers.server";

export const CAMPAIGN_FIELDS =
  "campaign_id,campaign_name,spend,impressions,inline_link_clicks,actions,action_values,account_currency";
export const AD_FIELDS =
  "ad_id,ad_name,adset_id,campaign_id,spend,impressions,inline_link_clicks,actions,action_values,account_currency";

const PAGE_LIMIT = "200";
const MAX_PAGES = 50; // safety bound on Insights pagination within one shop's single-pass pull

export interface InsightsQuery {
  level: "campaign" | "ad";
  since: string; // YYYY-MM-DD
  until: string; // YYYY-MM-DD
}

function check(r: MetaResponse): MetaResponse {
  if (r.error) {
    const code = r.error.code != null ? ` (code ${r.error.code})` : "";
    throw new Error(`Meta Insights error: ${r.error.message}${code}`);
  }
  return r;
}

export async function fetchInsights(
  client: MetaClient,
  adAccountId: string,
  q: InsightsQuery,
): Promise<InsightRow[]> {
  const baseParams: Record<string, string> = {
    level: q.level,
    fields: q.level === "ad" ? AD_FIELDS : CAMPAIGN_FIELDS,
    time_increment: "1",
    time_range: JSON.stringify({ since: q.since, until: q.until }),
    use_unified_attribution_setting: "true",
    action_report_time: "conversion",
    limit: PAGE_LIMIT,
  };

  const out: InsightRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = after ? { ...baseParams, after } : baseParams;
    const body = check(await client.get(`/${adAccountId}/insights`, params));
    out.push(...((body.data as InsightRow[]) ?? []));
    const paging = body.paging as { next?: string; cursors?: { after?: string } } | undefined;
    if (!paging?.next || !paging.cursors?.after) break;
    after = paging.cursors.after;
  }
  return out;
}
