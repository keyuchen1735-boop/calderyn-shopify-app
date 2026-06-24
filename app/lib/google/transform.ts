// Pure transform functions for the Google Ads connector.
//
// Google Ads API returns money fields in *micros* (1/1,000,000 of a unit),
// while our store keeps everything in cents. Convert via micros / 10_000.
//

import type {
  AdCampaignDim,
  AdSpendFact,
  GoogleCampaignPayload,
  GoogleReportRow,
} from "./types";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function normalizeStatus(s: string | undefined): AdCampaignDim["status"] {
  const v = (s ?? "").toUpperCase();
  if (v === "ENABLED") return "active";
  if (v === "REMOVED") return "archived";
  return "paused";
}

function microsToCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n / 10000);
}

function toIntOr0(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// Whole currency units → cents, NaN-safe. conversions_value arrives as a unit
// amount (e.g. "199.95"), unlike the micros money fields. An empty string or a
// malformed proto value must floor to 0 cents, never NaN (a NaN payload would
// serialize to null or fail a NOT NULL upsert).
function unitsToCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

// --------------------------------------------------------------------------
// Public transforms
// --------------------------------------------------------------------------

/**
 * Map a Google Ads campaign row (from the streaming search) to AdCampaignDim.
 * Status maps ENABLED→active / PAUSED→paused / REMOVED→archived.
 */
export function transformCampaign(c: GoogleCampaignPayload, shopId: string): AdCampaignDim {
  const id = c.campaign?.id;
  const externalId = id !== undefined && id !== null ? String(id) : "";

  const budgetMicros = c.campaign_budget?.amount_micros ?? null;
  const dailyBudgetCents =
    budgetMicros === null || budgetMicros === undefined || budgetMicros === ""
      ? null
      : microsToCents(budgetMicros);

  return {
    shop_id: shopId,
    platform: "google",
    external_id: externalId,
    name: c.campaign?.name ?? "",
    status: normalizeStatus(c.campaign?.status),
    objective: c.campaign?.advertising_channel_type ?? null,
    daily_budget_cents: dailyBudgetCents,
    currency: c.customer?.currency_code ?? "USD",
    geo_targets: c.geo_target_constants ?? [],
    created_at_source: c.campaign?.start_date ?? null,
  };
}

/**
 * Map a Google Ads `campaign + metrics + segments.date` report row to an
 * AdSpendFact. Metrics arrive in micros — convert money to cents.
 */
export function transformReportRow(r: GoogleReportRow, shopId: string): AdSpendFact {
  const id = r.campaign?.id;
  const campaignExternalId = id !== undefined && id !== null ? String(id) : "";
  return {
    shop_id: shopId,
    campaign_external_id: campaignExternalId,
    platform: "google",
    day: r.segments?.date ?? "",
    spend_cents: microsToCents(r.metrics?.cost_micros ?? null),
    impressions: toIntOr0(r.metrics?.impressions),
    clicks: toIntOr0(r.metrics?.clicks),
    conversions: toIntOr0(r.metrics?.conversions),
    revenue_attrib_cents: unitsToCents(r.metrics?.conversions_value),
  };
}
