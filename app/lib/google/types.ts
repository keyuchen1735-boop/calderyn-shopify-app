// Local types for the Google Ads connector.
//
// AdCampaignDim / AdSpendFact are now re-aliases of the shared normalized types
// from the generic ads core. This keeps the transform functions unchanged while
// routing through the platform-blind ingest pipeline.

import type { Platform, CampaignStatus, NormalizedCampaign, NormalizedSpendRow } from "../ads/adapter";

export type AdCampaignDim = NormalizedCampaign;   // produced shape is identical
export type AdSpendFact = NormalizedSpendRow;
export type { Platform, CampaignStatus };

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
    // v23 renamed start_date -> start_date_time (REST: startDateTime, normalized
    // to snake_case at the ingest boundary — see snakeKeysDeep).
    start_date_time?: string | null;
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
