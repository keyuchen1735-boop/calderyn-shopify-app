// fetch-based TikTok Business API client. Testable surface (getReport/getCampaigns/
// getAdvertiserCurrency) behind an interface so ingest is unit-testable with a fake.
// Rate errors (HTTP 429, body codes 40100/40016) and transient server errors
// (body codes 50000-59999, fetch timeout) become RateLimitError for withRetry.

import type { TikTokCampaignPayload, TikTokReportRow } from "./types";
import { RateLimitError } from "../ads/backoff";

const API_BASE = "https://business-api.tiktok.com/open_api/v1.3";
const REQUEST_TIMEOUT_MS = 30_000;

export interface TikTokClient {
  getReport(advertiserId: string, since: string, until: string): Promise<TikTokReportRow[]>;
  getCampaigns(advertiserId: string): Promise<TikTokCampaignPayload[]>;
  /** null when the Ad Account Management scope is unavailable — caller picks a fallback. */
  getAdvertiserCurrency(advertiserId: string): Promise<string | null>;
}

type TikTokPageInfo = { page?: number; page_size?: number; total_number?: number; total_page?: number };
type TikTokEnvelope = { code?: number; message?: string; data?: { list?: unknown[]; page_info?: TikTokPageInfo } };

/** Throws RateLimitError or generic Error on non-zero codes; returns list + totalPage. */
function check(body: TikTokEnvelope, what: string): { list: unknown[]; totalPage: number } {
  if (body.code === 40100 || body.code === 40016) throw new RateLimitError(`TikTok rate limit (code ${body.code})`);
  // 50000-59999 are TikTok's transient server-side errors (e.g. 50002 "Internal
  // service timeout"). Surface as RateLimitError so withRetry recovers from a
  // brief TikTok-side blip instead of failing the whole sync on one call.
  if (body.code !== undefined && body.code >= 50000 && body.code < 60000) {
    throw new RateLimitError(`TikTok transient server error (code ${body.code}: ${body.message ?? "unknown"})`);
  }
  if (body.code !== 0 && body.code !== undefined) throw new Error(`TikTok ${what} error: ${body.message ?? body.code}`);
  return {
    list: body.data?.list ?? [],
    totalPage: body.data?.page_info?.total_page ?? 1,
  };
}

export function buildTikTokClient(token: string): TikTokClient {
  async function call(path: string, params: Record<string, string>): Promise<TikTokEnvelope> {
    const qs = new URLSearchParams(params).toString();
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}?${qs}`, {
        headers: { "Access-Token": token },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // AbortSignal.timeout fires DOMException("...", "TimeoutError"); treat as
      // retryable so a single slow connection doesn't fail the whole sync.
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new RateLimitError(`TikTok request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    }
    if (res.status === 429) throw new RateLimitError("TikTok HTTP 429");
    return (await res.json()) as TikTokEnvelope;
  }

  return {
    async getReport(advertiserId, since, until) {
      const all: TikTokReportRow[] = [];
      let page = 1;
      let totalPage = 1;
      do {
        const body = await call("/report/integrated/get/", {
          advertiser_id: advertiserId,
          report_type: "BASIC",
          data_level: "AUCTION_CAMPAIGN",
          dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
          metrics: JSON.stringify(["spend", "impressions", "clicks", "conversion", "total_purchase_value"]),
          start_date: since,
          end_date: until,
          page: String(page),
          page_size: "1000",
        });
        const { list, totalPage: tp } = check(body, "report");
        for (const r of list) all.push(r as TikTokReportRow);
        totalPage = tp;
        page += 1;
      } while (page <= totalPage);
      return all;
    },

    async getCampaigns(advertiserId) {
      const all: TikTokCampaignPayload[] = [];
      let page = 1;
      let totalPage = 1;
      do {
        const body = await call("/campaign/get/", {
          advertiser_id: advertiserId,
          page: String(page),
          page_size: "1000",
        });
        const { list, totalPage: tp } = check(body, "campaign");
        for (const c of list) all.push(c as TikTokCampaignPayload);
        totalPage = tp;
        page += 1;
      } while (page <= totalPage);
      return all;
    },

    async getAdvertiserCurrency(advertiserId) {
      try {
        const body = await call("/advertiser/info/", {
          advertiser_ids: JSON.stringify([advertiserId]),
          fields: JSON.stringify(["currency"]),
        });
        const { list } = check(body, "advertiser/info");
        const first = list[0] as { currency?: unknown } | undefined;
        return typeof first?.currency === "string" ? first.currency : null;
      } catch {
        // Ad Account Management scope may not be granted; caller falls back.
        return null;
      }
    },
  };
}
