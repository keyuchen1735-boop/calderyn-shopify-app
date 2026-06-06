// Pure transforms for the Meta connector (covers Facebook + Instagram — both ride
// the same ad account / Insights API). Money fields arrive as major-unit strings
// (e.g. "12.34") → cents. Conversions/revenue come from the actions/action_values
// arrays; we read the purchase action types.

import type { NormalizedCampaign, NormalizedSpendRow, CampaignStatus } from "../ads/adapter";
import type { MetaCampaign } from "./campaigns.server";

const PURCHASE_ACTIONS = new Set(["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"]);

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

function normalizeStatus(s: string): CampaignStatus {
  const v = s.toUpperCase();
  if (v === "ACTIVE") return "active";
  if (v === "ARCHIVED" || v === "DELETED") return "archived";
  return "paused";
}

type MetaAction = { action_type?: string; value?: string | number };

export interface MetaInsightRow {
  campaign_id?: string;
  date_start?: string;
  spend?: string | number;
  impressions?: string | number;
  clicks?: string | number;
  actions?: MetaAction[];
  action_values?: MetaAction[];
}

function sumPurchase(actions: MetaAction[] | undefined): number {
  let total = 0;
  for (const a of actions ?? []) {
    if (a.action_type && PURCHASE_ACTIONS.has(a.action_type)) {
      const n = typeof a.value === "number" ? a.value : parseFloat(String(a.value ?? ""));
      if (Number.isFinite(n)) total += n;
    }
  }
  return total;
}

export function metaCampaignToNormalized(
  c: MetaCampaign,
  shopId: string,
  currency: string,
): NormalizedCampaign {
  return {
    shop_id: shopId,
    platform: "meta",
    external_id: c.id,
    name: c.name,
    status: normalizeStatus(c.status),
    objective: null,
    daily_budget_cents: c.dailyBudgetCents,
    currency,
    geo_targets: [],
    created_at_source: null,
  };
}

export function metaInsightToSpend(row: MetaInsightRow, shopId: string): NormalizedSpendRow {
  return {
    shop_id: shopId,
    campaign_external_id: row.campaign_id ?? "",
    platform: "meta",
    day: row.date_start ?? "",
    spend_cents: unitsToCents(row.spend),
    impressions: toIntOr0(row.impressions),
    clicks: toIntOr0(row.clicks),
    conversions: Math.round(sumPurchase(row.actions)),
    revenue_attrib_cents: Math.round(sumPurchase(row.action_values) * 100),
  };
}
