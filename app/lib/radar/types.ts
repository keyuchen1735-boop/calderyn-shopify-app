// Shared shapes for the Radar subsystem. The DB row is radar_ploy; every
// merchant-facing surface calls these "moves" - the internal noun never
// reaches UI strings or client bundles.

export type RadarMoveKind =
  | "seo_regression_patch"
  | "seo_meta_rewrite"
  | "seo_content_boost"
  | "aeo_refresh"
  | "aeo_jsonld_fix"
  | "section_refresh";

export type RadarMoveStatus = "draft" | "applied" | "dismissed" | "expired";

/** How Apply executes: publish_meta = product seo_page override; refresh_org =
 *  fill the store description; refresh_section = apply-time generation through
 *  the storefront pipelines; review = evidence + deep link, applying marks done. */
export type RadarApplyMode = "publish_meta" | "refresh_org" | "refresh_section" | "review";

export interface RadarEvidence {
  /** Short chip strings shown on the move card ("was #4", "now #9"). */
  chips: string[];
  /** Machine-readable facts backing the chips (numbers, urls, queries). */
  facts: Record<string, unknown>;
}

export interface RadarCandidate {
  kind: RadarMoveKind;
  dedupKey: string;
  headline: string;
  rationale: string;
  evidence: RadarEvidence;
  /** Always contains applyMode plus kind-specific fields (handle, focusQuery,
   *  target, brief, ...). Stored as radar_ploy.payload. */
  payload: Record<string, unknown> & { applyMode: RadarApplyMode };
}

export interface RankingDayPoint {
  day: string; // YYYY-MM-DD
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
}

export interface RankingSeries {
  pageUrl: string;
  query: string;
  days: RankingDayPoint[];
}

export interface TrafficPath {
  path: string;
  views: number;
  cartAdds: number;
  productId: string | null;
}

export interface TrafficDay {
  day: string; // YYYY-MM-DD
  views: number;
  sessions: number;
  cartAdds: number;
  checkouts: number;
  topPaths: TrafficPath[];
}

export interface AiCrawlDay {
  botName: string;
  day: string; // YYYY-MM-DD
  hits: number;
}

export interface JsonLdCheckedPage {
  productId: string;
  handle: string;
  title: string;
  issues: string[];
}

/** Everything the drafter's detectors consume, assembled by collect.server.ts. */
export interface RadarCollectInputs {
  traffic: TrafficDay[];
  rankings: RankingSeries[];
  aiCrawl: AiCrawlDay[];
  allowAiCrawlers: boolean;
  hasOrgDescription: boolean;
  /** Last publish of the storefront (either runtime), ISO string; null when unpublished. */
  lastPublishedAt: string | null;
  jsonLdIssues: JsonLdCheckedPage[];
}

/** Camel-case mirror of a radar_ploy row (mapped in store.server.ts). */
export interface RadarMoveRow {
  id: string;
  shopId: string;
  kind: RadarMoveKind;
  status: RadarMoveStatus;
  headline: string;
  rationale: string;
  evidence: RadarEvidence;
  payload: Record<string, unknown>;
  dedupKey: string;
  priorState: Record<string, unknown> | null;
  appliedStateHash: string | null;
  createdAt: string;
  appliedAt: string | null;
  resolvedAt: string | null;
  expiresAt: string;
}
