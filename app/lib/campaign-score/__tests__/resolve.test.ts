// app/lib/campaign-score/__tests__/resolve.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveCampaignScore, gradeRowFromPerformance } from "../resolve.server";
import type { AdScorecard } from "~/lib/screener/campaign-ads.server";
import type { ScoreCard, MetricScore } from "~/lib/screener/types";
import type { CampaignGradeRow } from "~/lib/types";
import { gradeFromRow } from "~/lib/campaign-grade";

function card(composite: number, metrics: MetricScore[] = [], tips: ScoreCard["tips"] = []): ScoreCard {
  return {
    composite, grade: "okay", confidence: "high", summary: "", metrics,
    outcomes: {
      estimatedRoas: 0, roasLow: 0, roasHigh: 0, breakEvenRoas: 0,
      predictedCtr: 0, holdRate: 0, assumedSpendCents: 0, predictedRevenueCents: 0,
      mappedSku: null, skuPriceCents: null,
    },
    tips,
  };
}
function done(adId: string, composite: number, metrics: MetricScore[] = [], tips: ScoreCard["tips"] = []): AdScorecard {
  return { adId, status: "done", scorecard: card(composite, metrics, tips), error: null };
}
const grade = (over: Partial<CampaignGradeRow> = {}): CampaignGradeRow => ({
  campaign_id: "c1", name: "C", grade: "", roas: 4, break_even_roas: 2,
  spend_cents: 10000, revenue_cents: 40000, day_bucket: "2026-06-27", ...over,
});

describe("resolveCampaignScore", () => {
  it("blends P and cached C, loading ONLY active ad ids; adsTotal = active count", async () => {
    const loader = vi.fn(async (_shop: string, ids: string[]) => ids.map((id) => done(id, 80)));
    const score = await resolveCampaignScore(
      "shop",
      { id: "c1", ads: [{ adId: "a1", status: "active" }, { adId: "a2", status: "paused" }] },
      grade(),
      { loadCachedAdScorecards: loader },
    );
    expect(loader).toHaveBeenCalledWith("shop", ["a1"]);
    expect(score.performance).toBe(100); // clamp(round(50*4/2),0,100) = 100
    expect(score.creative).toBe(80);
    expect(score.value).toBe(94); // round(0.7*100 + 0.3*80)
    expect(score.band).toBe("strong");
    expect(score.adsCovered).toBe(1);
    expect(score.adsTotal).toBe(1);
  });

  it("skips the loader and returns performance-only when there are no active ads", async () => {
    const loader = vi.fn(async () => [] as AdScorecard[]);
    const score = await resolveCampaignScore(
      "shop", { id: "c1", ads: [{ adId: "p", status: "paused" }] }, grade(), { loadCachedAdScorecards: loader },
    );
    expect(loader).not.toHaveBeenCalled();
    expect(score.creative).toBeNull();
    expect(score.performance).toBe(100);
    expect(score.value).toBe(100);
  });

  it("maps a nodata grade row (spend, zero attributed revenue) to P = null", async () => {
    const loader = vi.fn(async (_s: string, ids: string[]) => ids.map((id) => done(id, 60)));
    const row = grade({ roas: 0, revenue_cents: 0, spend_cents: 10000 });
    expect(gradeFromRow(row)).toBe("nodata");
    const score = await resolveCampaignScore(
      "shop", { id: "c1", ads: [{ adId: "a1", status: "active" }] }, row, { loadCachedAdScorecards: loader },
    );
    expect(score.performance).toBeNull();
    expect(score.creative).toBe(60);
    expect(score.value).toBe(60);
  });

  it("never throws when the cached loader rejects — creative half degrades to null", async () => {
    const loader = vi.fn(async () => { throw new Error("supabase down"); });
    const score = await resolveCampaignScore(
      "shop", { id: "c1", ads: [{ adId: "a1", status: "active" }] }, grade(), { loadCachedAdScorecards: loader },
    );
    expect(score.creative).toBeNull();
    expect(score.performance).toBe(100);
  });

  it("forwards aggregated weakDimensions + tips from active scored ads", async () => {
    const m: MetricScore = { id: "hook", group: "attention", label: "Hook strength", score: 40, reasoning: "" };
    const loader = vi.fn(async (_s: string, ids: string[]) => ids.map((id) => done(id, 70, [m], ["Tighten the hook"])));
    const score = await resolveCampaignScore(
      "shop", { id: "c1", ads: [{ adId: "a1", status: "active" }] }, grade(), { loadCachedAdScorecards: loader },
    );
    expect(score.weakDimensions).toEqual([{ label: "Hook strength", score: 40, adId: "a1" }]);
    expect(score.tips).toEqual(["Tighten the hook"]);
  });

  it("gradeRowFromPerformance yields nodata when spend exists but ROAS is 0", () => {
    const row = gradeRowFromPerformance({ campaignId: "c1", name: "C", roas: 0, breakEvenRoas: 0, spendCents: 5000 });
    expect(row.revenue_cents).toBe(0);
    expect(gradeFromRow(row)).toBe("nodata");
  });
});
