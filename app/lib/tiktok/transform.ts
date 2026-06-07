// Pure transforms for the TikTok connector. spend/value are major-unit strings →
// cents; stat_time_day is "YYYY-MM-DD HH:MM:SS" → take the date.

import type { NormalizedCampaign, NormalizedSpendRow, CampaignStatus } from "../ads/adapter";
import type { TikTokCampaignPayload, TikTokReportRow } from "./types";

function unitsToCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function toIntOr0(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function normalizeStatus(s: string | undefined): CampaignStatus {
  const v = (s ?? "").toUpperCase();
  if (v === "ENABLE") return "active";
  if (v === "DELETE") return "archived";
  return "paused";
}

export function tiktokCampaignToNormalized(
  c: TikTokCampaignPayload,
  shopId: string,
  currency: string,
): NormalizedCampaign {
  return {
    shop_id: shopId,
    platform: "tiktok",
    external_id: c.campaign_id ?? "",
    name: c.campaign_name ?? "",
    status: normalizeStatus(c.operation_status),
    objective: null,
    daily_budget_cents: c.budget === undefined ? null : unitsToCents(c.budget),
    currency,
    geo_targets: [],
    created_at_source: null,
  };
}

export function tiktokReportToSpend(r: TikTokReportRow, shopId: string): NormalizedSpendRow {
  const day = (r.dimensions?.stat_time_day ?? "").slice(0, 10);
  return {
    shop_id: shopId,
    campaign_external_id: r.dimensions?.campaign_id ?? "",
    platform: "tiktok",
    day,
    spend_cents: unitsToCents(r.metrics?.spend),
    impressions: toIntOr0(r.metrics?.impressions),
    clicks: toIntOr0(r.metrics?.clicks),
    conversions: toIntOr0(r.metrics?.conversion),
    revenue_attrib_cents: unitsToCents(r.metrics?.total_purchase_value),
  };
}
