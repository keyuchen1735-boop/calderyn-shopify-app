// app/lib/campaign-score/__tests__/aggregate.test.ts
import { describe, it, expect } from "vitest";
import { aggregateAdScorecards } from "../aggregate.server";
import type { AdScorecard } from "~/lib/screener/campaign-ads.server";
import type { ScoreCard, MetricScore } from "~/lib/screener/types";

function metric(label: string, score: number): MetricScore {
  return { id: label.toLowerCase().replace(/\s+/g, "_"), group: "attention", label, score, reasoning: "" };
}
function card(composite: number, metrics: MetricScore[], tips: ScoreCard["tips"]): ScoreCard {
  return {
    composite,
    grade: "okay",
    confidence: "high",
    summary: "",
    metrics,
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
function errored(adId: string): AdScorecard {
  return { adId, status: "error", scorecard: null, error: "boom" };
}

describe("aggregateAdScorecards", () => {
  it("returns null composite + zero coverage for zero ads", () => {
    expect(aggregateAdScorecards([])).toEqual({
      creativeComposite: null, weakDimensions: [], tips: [], coverage: { covered: 0, total: 0 },
    });
  });

  it("means scored composites; errors are excluded from the mean but counted in total", () => {
    const agg = aggregateAdScorecards([done("a1", 80), done("a2", 60), errored("a3")]);
    expect(agg.creativeComposite).toBe(70);
    expect(agg.coverage).toEqual({ covered: 2, total: 3 });
  });

  it("collects weak dimensions (<65) across ads, tagged with adId, sorted ascending", () => {
    const agg = aggregateAdScorecards([
      done("a1", 70, [metric("Hook strength", 40), metric("CTA strength", 90)]),
      done("a2", 55, [metric("Headline clarity", 50)]),
    ]);
    expect(agg.weakDimensions).toEqual([
      { label: "Hook strength", score: 40, adId: "a1" },
      { label: "Headline clarity", score: 50, adId: "a2" },
    ]);
  });

  it("dedupes tips across ads by normalized title", () => {
    const agg = aggregateAdScorecards([
      done("a1", 70, [], ["Tighten the hook", "Add social proof"]),
      done("a2", 70, [], ["Tighten the hook"]),
    ]);
    expect(agg.tips).toEqual(["Tighten the hook", "Add social proof"]);
  });
});
