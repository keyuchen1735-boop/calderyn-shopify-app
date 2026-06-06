// Loose TikTok Business API payload types (proto-ish JSON). Precise optionals,
// never `any` — the documented raw-API-payload exception.

export interface TikTokCampaignPayload {
  campaign_id?: string;
  campaign_name?: string;
  operation_status?: string; // 'ENABLE' | 'DISABLE'
  budget?: string | number;  // major currency units (daily budget)
}

export interface TikTokReportRow {
  dimensions?: {
    campaign_id?: string;
    stat_time_day?: string; // "YYYY-MM-DD HH:MM:SS"
  };
  metrics?: {
    spend?: string | number;
    impressions?: string | number;
    clicks?: string | number;
    conversion?: string | number;
    total_purchase_value?: string | number;
  };
}
