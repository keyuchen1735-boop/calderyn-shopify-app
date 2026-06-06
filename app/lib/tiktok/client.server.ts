// fetch-based TikTok Business API client. Testable surface (getReport/getCampaigns)
// behind an interface so ingest is unit-testable with a fake. Rate errors
// (HTTP 429 or body code 40100) become RateLimitError for withRetry.

import type { TikTokCampaignPayload, TikTokReportRow } from "./types";
import { RateLimitError } from "../ads/backoff";

const API_BASE = "https://business-api.tiktok.com/open_api/v1.3";

export interface TikTokClient {
  getReport(advertiserId: string, since: string, until: string): Promise<TikTokReportRow[]>;
  getCampaigns(advertiserId: string): Promise<TikTokCampaignPayload[]>;
}

type TikTokEnvelope = { code?: number; message?: string; data?: { list?: unknown[] } };

function unwrap(body: TikTokEnvelope, what: string): unknown[] {
  if (body.code === 40100 || body.code === 40016) throw new RateLimitError(`TikTok rate limit (code ${body.code})`);
  if (body.code !== 0 && body.code !== undefined) throw new Error(`TikTok ${what} error: ${body.message ?? body.code}`);
  return body.data?.list ?? [];
}

export function buildTikTokClient(token: string): TikTokClient {
  async function call(path: string, params: Record<string, string>): Promise<TikTokEnvelope> {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${API_BASE}${path}?${qs}`, { headers: { "Access-Token": token } });
    if (res.status === 429) throw new RateLimitError("TikTok HTTP 429");
    return (await res.json()) as TikTokEnvelope;
  }
  return {
    async getReport(advertiserId, since, until) {
      const body = await call("/report/integrated/get/", {
        advertiser_id: advertiserId,
        report_type: "BASIC",
        data_level: "AUCTION_CAMPAIGN",
        dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
        metrics: JSON.stringify(["spend", "impressions", "clicks", "conversion", "total_purchase_value"]),
        start_date: since,
        end_date: until,
        page_size: "1000",
      });
      return unwrap(body, "report") as TikTokReportRow[];
    },
    async getCampaigns(advertiserId) {
      const body = await call("/campaign/get/", { advertiser_id: advertiserId, page_size: "1000" });
      return unwrap(body, "campaign") as TikTokCampaignPayload[];
    },
  };
}
