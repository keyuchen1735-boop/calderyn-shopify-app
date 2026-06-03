// Pure: Meta Insights JSON rows -> Supabase fact/dim row shapes. No I/O.

export interface InsightAction {
  action_type: string;
  value?: string;
}

export interface InsightRow {
  campaign_id?: string;
  campaign_name?: string;
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  date_start?: string;
  spend?: string;
  impressions?: string;
  inline_link_clicks?: string;
  account_currency?: string;
  actions?: InsightAction[];
  action_values?: InsightAction[];
}

// Priority order for purchases: prefer the omni superset, never sum both.
const PURCHASE_TYPES = ["omni_purchase", "purchase"] as const;

function toCents(v: string | undefined): number {
  if (v == null) return 0;
  return Math.round(Number(v) * 100);
}

function toInt(v: string | undefined): number {
  if (v == null) return 0;
  return Math.trunc(Number(v));
}

/** First matching action_type in priority order; numeric value or 0. */
function pickByPriority(arr: InsightAction[] | undefined, types: readonly string[]): number {
  if (!arr) return 0;
  for (const t of types) {
    const hit = arr.find((a) => a.action_type === t);
    if (hit) return Number(hit.value ?? 0);
  }
  return 0;
}

/** Exact action_type value or 0. */
function pickExact(arr: InsightAction[] | undefined, type: string): number {
  if (!arr) return 0;
  const hit = arr.find((a) => a.action_type === type);
  return hit ? Number(hit.value ?? 0) : 0;
}

export function mapCampaignInsight(shopId: string, row: InsightRow) {
  return {
    shop_id: shopId,
    campaign_external_id: String(row.campaign_id ?? ""),
    day_bucket: String(row.date_start ?? ""),
    spend_cents: toCents(row.spend),
    impressions: toInt(row.impressions),
    link_clicks: toInt(row.inline_link_clicks),
    purchases: Math.trunc(pickByPriority(row.actions, PURCHASE_TYPES)),
    purchase_value_cents: Math.round(pickByPriority(row.action_values, PURCHASE_TYPES) * 100),
    currency: row.account_currency ?? "USD",
  };
}

export function mapAdInsight(shopId: string, row: InsightRow) {
  return {
    shop_id: shopId,
    ad_external_id: String(row.ad_id ?? ""),
    campaign_external_id: String(row.campaign_id ?? ""),
    day_bucket: String(row.date_start ?? ""),
    spend_cents: toCents(row.spend),
    impressions: toInt(row.impressions),
    link_clicks: toInt(row.inline_link_clicks),
    purchases: Math.trunc(pickByPriority(row.actions, PURCHASE_TYPES)),
    purchase_value_cents: Math.round(pickByPriority(row.action_values, PURCHASE_TYPES) * 100),
    currency: row.account_currency ?? "USD",
    reactions: Math.trunc(pickExact(row.actions, "post_reaction")),
    comments: Math.trunc(pickExact(row.actions, "comment")),
    shares: Math.trunc(pickExact(row.actions, "post")),
    saves: Math.trunc(pickExact(row.actions, "onsite_conversion.post_save")),
    post_engagement: Math.trunc(pickExact(row.actions, "post_engagement")),
  };
}

export function mapAdDim(shopId: string, row: InsightRow) {
  return {
    shop_id: shopId,
    external_id: String(row.ad_id ?? ""),
    campaign_external_id: String(row.campaign_id ?? ""),
    adset_external_id: row.adset_id != null ? String(row.adset_id) : null,
    name: String(row.ad_name ?? ""),
  };
}

export function mapCampaignDim(shopId: string, row: InsightRow) {
  return {
    shop_id: shopId,
    external_id: String(row.campaign_id ?? ""),
    name: String(row.campaign_name ?? ""),
  };
}
