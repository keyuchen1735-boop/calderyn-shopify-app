// Shared, platform-blind ad-ingestion contract. Each ad platform (meta, google,
// tiktok) implements only `connect()` + a per-shop `ShopAdSource` that returns
// NORMALIZED rows. The generic ingest core (ads/ingest.server.ts) and everything
// above it (grading, actions) never branch on platform.

export type Platform = "meta" | "google" | "tiktok";

export type IntegrationKind = "meta_ads" | "google_ads" | "tiktok_ads";

export type CampaignStatus = "active" | "paused" | "archived";

/** Mirrors the ad_campaign_dim upsert shape, platform-agnostic. */
export interface NormalizedCampaign {
  shop_id: string;
  platform: Platform;
  external_id: string;
  name: string;
  status: CampaignStatus;
  objective: string | null;
  daily_budget_cents: number | null;
  currency: string;
  geo_targets: string[];
  created_at_source: string | null;
}

/** Mirrors the ad_spend_fact upsert shape, keyed by campaign EXTERNAL id. */
export interface NormalizedSpendRow {
  shop_id: string;
  campaign_external_id: string;
  platform: Platform;
  day: string; // YYYY-MM-DD
  spend_cents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue_attrib_cents: number;
}

/** Per-shop, already-authenticated handle over one platform's data. */
export interface ShopAdSource {
  fetchCampaigns(): Promise<NormalizedCampaign[]>;
  fetchBackfillSpend(): Promise<NormalizedSpendRow[]>; // trailing ~90 days
  fetchDailySpend(day: string): Promise<NormalizedSpendRow[]>; // one YYYY-MM-DD
}

/** A platform plug. `connect` returns null when the shop has no usable creds. */
export interface AdPlatformAdapter {
  readonly platform: Platform;
  readonly integrationKind: IntegrationKind;
  connect(shopId: string): Promise<ShopAdSource | null>;
}
