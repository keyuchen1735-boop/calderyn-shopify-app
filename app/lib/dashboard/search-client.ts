// app/lib/dashboard/search-client.ts
// Browser data layer for the Search screen. The interfaces below are browser-safe
// mirrors of the VMs returned by app/lib/seo/overview.server.ts (a .server module
// cannot be imported into the client bundle) — keep them in sync by hand when the
// server VM changes.
import { apiGet, apiSend } from "./client";

export interface NeedsAttentionRow {
  id: string;
  handle: string;
  title: string;
  score: number;
  topIssue: string | null;
  hasOverride: boolean;
}
export interface AiCrawlRow { botName: string; hits: number; }
export interface SeoSettings {
  allowAiCrawlers: boolean;
  orgName: string | null;
  orgDescription: string | null;
}
export interface GoogleCardVM {
  connected: boolean;
  clicks: number;
  impressions: number;
  topQuery: string | null;
  topPosition: number | null;
}
export interface SeoOverviewVM {
  storeHealth: number;
  productCount: number;
  needsAttention: NeedsAttentionRow[];
  aiCrawls: AiCrawlRow[];
  aiCrawlTotal: number;
  settings: SeoSettings;
  google: GoogleCardVM;
}
export interface GooglePreview { title: string; url: string; description: string; }
export interface HealthCheckVM { id: string; label: string; status: "pass" | "warn" | "fail"; hint?: string; }
export interface ProductSeoDetailVM {
  id: string;
  handle: string;
  title: string;
  googlePreview: GooglePreview;
  health: { score: number; checks: HealthCheckVM[] };
  override: { metaTitle: string | null; metaDescription: string | null } | null;
  aiSummary: string;
}

export const fetchSearch = () => apiGet<SeoOverviewVM>("/dashboard/api/search");

// Browser-safe mirror of SearchPreview in overview.server.ts (a .server module
// cannot be imported into the client bundle) — keep in sync by hand.
export interface SearchPreviewSample {
  title: string;
  url: string;
  description: string;
}
export interface SearchPreview {
  storeName: string;
  productCount: number;
  sample: SearchPreviewSample | null;
}
export interface SearchOverviewVM {
  settings: SeoSettings;
  preview: SearchPreview;
}

// The Search screen's own read: this shop's settings plus a small live preview
// (store name, product count, one sample product's auto-written SEO). The loader
// returns { settings, preview } for a GET; the whole payload is cached as-is.
export const fetchSearchOverview = (): Promise<SearchOverviewVM> =>
  apiGet<SearchOverviewVM>("/dashboard/api/search");

export const loadProductDetail = (handle: string) =>
  apiSend<ProductSeoDetailVM>("POST", "/dashboard/api/search", { action: "detail", handle });

export const saveOverride = (payload: { entityId: string; metaTitle: string; metaDescription: string }) =>
  apiSend<{ ok: true }>("POST", "/dashboard/api/search", { action: "saveOverride", ...payload });

export const resetOverride = (entityId: string) =>
  apiSend<{ ok: true }>("POST", "/dashboard/api/search", { action: "resetOverride", entityId });

export const updateSettings = (patch: Partial<SeoSettings>) =>
  apiSend<{ settings: SeoSettings }>("POST", "/dashboard/api/search", { action: "updateSettings", ...patch });

export const connectGoogleSearchConsole = () =>
  apiSend<{ url: string }>("POST", "/dashboard/api/search", { action: "connectGoogle" });

export const disconnectGoogleSearchConsole = () =>
  apiSend<{ ok: true }>("POST", "/dashboard/api/search", { action: "disconnectGoogle" });
