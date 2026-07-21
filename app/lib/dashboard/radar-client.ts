// app/lib/dashboard/radar-client.ts
// Browser data layer for the Radar screen. VM shapes are hand-kept mirrors of
// dashboard.api.radar's loader/action payloads (a .server module cannot be
// imported into the client bundle) - same convention as search-client.ts.
import { apiGet, apiSend } from "./client";

export interface RadarMoveVM {
  id: string;
  kind: string;
  status: "draft" | "applied" | "dismissed" | "expired";
  headline: string;
  rationale: string;
  chips: string[];
  reviewOnly: boolean;
  deepLink: string | null;
  canRevert: boolean;
  reverted: boolean;
  createdAt: string;
  appliedAt: string | null;
  resolvedAt: string | null;
}

export interface RadarSignalsVM {
  traffic: { yesterdayViews: number; weeklyAverage: number; lastCheckedAt: string | null };
  google: { connected: boolean; lastCapturedDate: string | null; slippingCount: number };
  aiAssistants: { hitsLast7: number; hitsPrior7: number };
  competitors: { watching: number; suggested: number; changesLast7: number; lastChangeAt: string | null };
}

export interface RadarCompetitorChangeVM {
  day: string;
  url: string;
  chips: string[];
}

export interface RadarCompetitorVM {
  id: string;
  name: string;
  host: string;
  url: string;
  status: "suggested" | "watching" | "dismissed";
  reason: string;
  addedAt: string;
  changes: RadarCompetitorChangeVM[];
}

export interface RadarCompetitorsVM {
  suggested: RadarCompetitorVM[];
  watching: RadarCompetitorVM[];
  watchLimit: number;
}

export interface RadarOverviewVM {
  moves: RadarMoveVM[];
  history: RadarMoveVM[];
  signals: RadarSignalsVM;
  competitors: RadarCompetitorsVM;
  /** radar_state.lastCollectedAt - null if Radar has never checked this shop. */
  lastCheckedAt: string | null;
  /** true when lastCheckedAt is null or older than 20 hours - the screen uses
   *  this to trigger an immediate per-shop check on open. */
  stale: boolean;
}

/** Merchant-facing labels per move kind (plain language, no jargon). */
export const RADAR_KIND_LABELS: Record<string, string> = {
  seo_regression_patch: "Google ranking",
  seo_meta_rewrite: "Google ranking",
  seo_content_boost: "Google ranking",
  aeo_refresh: "AI assistants",
  aeo_jsonld_fix: "AI assistants",
  section_refresh: "Store page",
  competitor_counter: "Competitor",
  competitor_price: "Competitor pricing",
};

export const fetchRadar = (): Promise<RadarOverviewVM> => apiGet<RadarOverviewVM>("/dashboard/api/radar");

export const applyRadarMove = (moveId: string) =>
  apiSend<{ move: RadarMoveVM }>("POST", "/dashboard/api/radar", { action: "apply", moveId });

export const dismissRadarMove = (moveId: string) =>
  apiSend<{ move: RadarMoveVM }>("POST", "/dashboard/api/radar", { action: "dismiss", moveId });

export const revertRadarMove = (moveId: string, confirm = false) =>
  apiSend<{ move: RadarMoveVM }>("POST", "/dashboard/api/radar", { action: "revert", moveId, confirm });

export const confirmRadarCompetitor = (competitorId: string) =>
  apiSend<{ competitors: RadarCompetitorsVM; firstLook?: boolean }>("POST", "/dashboard/api/radar", {
    action: "competitor_confirm",
    competitorId,
  });

export const dismissRadarCompetitor = (competitorId: string) =>
  apiSend<{ competitors: RadarCompetitorsVM }>("POST", "/dashboard/api/radar", {
    action: "competitor_dismiss",
    competitorId,
  });

export interface RadarRefreshVM {
  refreshed: boolean;
  reason?: "fresh";
  /** Only present when refreshed: true. */
  drafted?: number;
}

/** Runs an immediate per-shop check (collect + draft), rate-limited
 *  server-side to once per 30 minutes independent of the nightly Claude
 *  quota. Used both for the screen's own stale-on-open check and the
 *  merchant-facing "Check now" button. */
export const refreshRadar = (): Promise<RadarRefreshVM> =>
  apiSend<RadarRefreshVM>("POST", "/dashboard/api/radar", { action: "refresh" });

export interface RadarHomeVM {
  readyCount: number;
  dismissed: boolean;
}

export const fetchRadarHome = (): Promise<RadarHomeVM> => apiGet<RadarHomeVM>("/dashboard/api/radar-home");

export const dismissRadarHomeCard = () =>
  apiSend<{ ok: boolean }>("POST", "/dashboard/api/radar-home", { intent: "dismiss" });
