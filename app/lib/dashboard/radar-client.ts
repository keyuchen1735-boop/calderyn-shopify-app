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
  competitors: { comingSoon: true };
}

export interface RadarOverviewVM {
  moves: RadarMoveVM[];
  history: RadarMoveVM[];
  signals: RadarSignalsVM;
}

/** Merchant-facing labels per move kind (plain language, no jargon). */
export const RADAR_KIND_LABELS: Record<string, string> = {
  seo_regression_patch: "Google ranking",
  seo_meta_rewrite: "Google ranking",
  seo_content_boost: "Google ranking",
  aeo_refresh: "AI assistants",
  aeo_jsonld_fix: "AI assistants",
  section_refresh: "Store page",
};

export const fetchRadar = (): Promise<RadarOverviewVM> => apiGet<RadarOverviewVM>("/dashboard/api/radar");

export const applyRadarMove = (moveId: string) =>
  apiSend<{ move: RadarMoveVM }>("POST", "/dashboard/api/radar", { action: "apply", moveId });

export const dismissRadarMove = (moveId: string) =>
  apiSend<{ move: RadarMoveVM }>("POST", "/dashboard/api/radar", { action: "dismiss", moveId });

export const revertRadarMove = (moveId: string, confirm = false) =>
  apiSend<{ move: RadarMoveVM }>("POST", "/dashboard/api/radar", { action: "revert", moveId, confirm });

export interface RadarHomeVM {
  readyCount: number;
  dismissed: boolean;
}

export const fetchRadarHome = (): Promise<RadarHomeVM> => apiGet<RadarHomeVM>("/dashboard/api/radar-home");

export const dismissRadarHomeCard = () =>
  apiSend<{ ok: boolean }>("POST", "/dashboard/api/radar-home", { intent: "dismiss" });
