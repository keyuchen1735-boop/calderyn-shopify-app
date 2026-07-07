// app/lib/dashboard/search-client.ts
// Browser data layer for the Preferences (SEO/AIO) screen. SeoSettings is a
// browser-safe mirror of the shape returned by the dashboard.api.search loader
// (a .server module cannot be imported into the client bundle) — keep it in sync
// by hand when the server settings shape changes.
import { apiGet, apiSend } from "./client";

export interface SeoSettings {
  allowSearchEngines: boolean;
  allowAiCrawlers: boolean;
  orgName: string | null;
  orgDescription: string | null;
  googleSiteVerification: string | null;
}

export interface SearchOverviewVM {
  settings: SeoSettings;
  // This shop's live sitemap URL, or null until it has a storefront slug.
  sitemapUrl: string | null;
}

// The Preferences screen's own read: just this shop's SEO settings. The loader
// returns { settings } for a GET; the whole payload is cached as-is.
export const fetchSearchOverview = (): Promise<SearchOverviewVM> =>
  apiGet<SearchOverviewVM>("/dashboard/api/search");

export const updateSettings = (patch: Partial<SeoSettings>) =>
  apiSend<{ settings: SeoSettings }>("POST", "/dashboard/api/search", { action: "updateSettings", ...patch });

// Ask Calderyn to draft a store description from the shop's own catalog + identity.
// Returns the suggestion for the merchant to review and save; it is not persisted.
export const suggestDescription = () =>
  apiSend<{ description: string }>("POST", "/dashboard/api/search", { action: "suggestDescription" });
