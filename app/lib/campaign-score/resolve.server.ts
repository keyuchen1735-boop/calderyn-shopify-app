// app/lib/campaign-score/resolve.server.ts
// Resolve a campaign's blended Calderyn score from CACHED ad scorecards + its
// grade row. Loads only ACTIVE ads' cached scorecards (D1), supplies the
// authoritative coverage total (D2), maps the performance half from the grade
// row, and blends. Never throws — a failed cache read degrades the creative half
// to null rather than breaking the caller (rule 12). DI via `deps` for tests.
import { gradeFromRow } from "../campaign-grade";
import type { CampaignGradeRow } from "../types";
import type { AdScorecard } from "../screener/campaign-ads.server";
import { loadCachedAdScorecards as realLoadCached } from "../screener/campaign-ads.server";
import { aggregateAdScorecards } from "./aggregate.server";
import { blendScore } from "./blend.server";
import { PERF_ANCHOR } from "./types";
import type { CampaignCalderynScore } from "./types";

/** Minimal campaign shape resolve needs: its id + its ads with active/paused. */
export interface CampaignLike {
  id: string;
  ads: { adId: string; status: "active" | "paused" }[];
}

/** Injected dependency seam (tests pass a fake cached-scorecard loader). */
export interface ResolveScoreDeps {
  loadCachedAdScorecards: (shop: string, adIds: string[]) => Promise<AdScorecard[]>;
}

function defaultDeps(): ResolveScoreDeps {
  return { loadCachedAdScorecards: realLoadCached };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Synthesize a CampaignGradeRow from a campaign's live performance numbers (used
 * by the embedded loader, which has CampaignPerformance, not a grade row).
 * revenue = roas × spend, so when there is spend but no usable ROAS the row
 * resolves to "nodata" through gradeFromRow — never a fabricated revenue.
 */
export function gradeRowFromPerformance(args: {
  campaignId: string;
  name: string;
  roas: number;
  breakEvenRoas: number;
  spendCents: number;
}): CampaignGradeRow {
  const roas = Number.isFinite(args.roas) && args.roas > 0 ? args.roas : 0;
  const spendCents = Number.isFinite(args.spendCents) && args.spendCents > 0 ? args.spendCents : 0;
  const breakEven = Number.isFinite(args.breakEvenRoas) && args.breakEvenRoas > 0 ? args.breakEvenRoas : 0;
  return {
    campaign_id: args.campaignId,
    name: args.name,
    grade: "",
    roas,
    break_even_roas: breakEven,
    spend_cents: spendCents,
    revenue_cents: Math.round(roas * spendCents),
    day_bucket: "",
  };
}

export async function resolveCampaignScore(
  shop: string,
  campaign: CampaignLike,
  gradeRow: CampaignGradeRow | undefined,
  deps: ResolveScoreDeps = defaultDeps(),
): Promise<CampaignCalderynScore> {
  // D1: only active ads contribute to the creative half. Paused ads aren't
  // running, so their creatives never enter the aggregate.
  const activeAdIds = campaign.ads
    .filter((a) => a.status === "active")
    .map((a) => a.adId)
    .filter((id) => id.length > 0);

  let scorecards: AdScorecard[] = [];
  if (activeAdIds.length > 0) {
    try {
      scorecards = await deps.loadCachedAdScorecards(shop, activeAdIds);
    } catch {
      scorecards = []; // rule 12: degrade the creative half, never throw.
    }
  }

  const agg = aggregateAdScorecards(scorecards);

  // Performance half. nodata (spend but zero attributed revenue) or a missing /
  // non-positive break-even both yield P = null — never fabricate (rule 12).
  const perfIsNodata = gradeRow ? gradeFromRow(gradeRow) === "nodata" : false;
  let performance: number | null = null;
  if (gradeRow && !perfIsNodata && gradeRow.break_even_roas > 0) {
    performance = clamp(Math.round((PERF_ANCHOR * gradeRow.roas) / gradeRow.break_even_roas), 0, 100);
  }

  const blended = blendScore({
    performance,
    creative: agg.creativeComposite,
    // D2: the cache-only loader omits unscored ads, so the authoritative total
    // is the active-ad count, not agg.coverage.total.
    coverage: { covered: agg.coverage.covered, total: activeAdIds.length },
    perfIsNodata,
  });

  return { ...blended, weakDimensions: agg.weakDimensions, tips: agg.tips };
}
