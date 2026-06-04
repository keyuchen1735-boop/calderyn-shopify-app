// Local types for the Google Ads connector.
//
// The monorepo imported AdCampaignDim / AdSpendFact from `@calderyn/shared/schemas`,
// which does not exist in this repo. They are re-declared here to match the exact
// shapes the transforms produce (see ./transform.ts).

export type CampaignStatus = "active" | "paused" | "archived";

export type AdCampaignDim = {
  shop_id: string;
  platform: "google";
  external_id: string;
  name: string;
  status: CampaignStatus;
  objective: string | null;
  daily_budget_cents: number | null;
  currency: string;
  geo_targets: string[];
  created_at_source: string | null;
};

export type AdSpendFact = {
  shop_id: string;
  campaign_external_id: string;
  platform: "google";
  day: string;
  spend_cents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue_attrib_cents: number;
};

// --------------------------------------------------------------------------
// Loose Google Ads API payload types
//
// These mirror the raw JSON the Google Ads searchStream endpoint returns. The
// API is loosely typed (proto-derived), so optional fields and string|number
// money values are intentional — this is the documented "raw API payload"
// exception to the no-`any` rule (we use precise optionals, never `any`).
// --------------------------------------------------------------------------

export interface GoogleCampaignPayload {
  campaign?: {
    id?: string | number;
    resource_name?: string;
    name?: string;
    status?: string; // 'ENABLED' | 'PAUSED' | 'REMOVED'
    advertising_channel_type?: string;
    start_date?: string | null;
  };
  campaign_budget?: {
    amount_micros?: string | number | null;
  };
  customer?: {
    currency_code?: string;
  };
  geo_target_constants?: string[];
}

export interface GoogleReportRow {
  campaign?: {
    id?: string | number;
  };
  metrics?: {
    cost_micros?: string | number | null;
    impressions?: string | number | null;
    clicks?: string | number | null;
    conversions?: string | number | null;
    conversions_value?: string | number | null;
  };
  segments?: {
    date?: string; // YYYY-MM-DD
  };
}
