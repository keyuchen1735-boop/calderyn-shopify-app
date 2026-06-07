import type { Platform } from "../ads/adapter";

export type { Platform };

export type ClickIdKind = "fbclid" | "gclid" | "ttclid";

export type AttributionMethod = "utm_exact" | "click_id" | "referrer_host" | "unknown";

export type Confidence = "high" | "strong" | "rough" | "none";

/** UTM params we read (all optional). */
export interface Utm {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
}

/** Click-ID breadcrumbs keyed by kind. */
export type ClickIds = Partial<Record<ClickIdKind, string>>;

/** Everything the matcher needs from one order. */
export interface AttributionSignals {
  utm: Utm;
  clickIds: ClickIds;
  referringSite: string | null;
}

/** A campaign the order could be attributed to. */
export interface CampaignRef {
  id: string; // ad_campaign_dim uuid
  external_id: string;
  name: string;
  platform: Platform;
}

export interface AttributionResult {
  campaignId: string | null;
  platform: Platform | null;
  method: AttributionMethod;
  confidence: Confidence;
}
