import { describe, it, expect, vi } from "vitest";
import { loadOrScoreAdScorecards, type ScoreAdsDeps } from "../campaign-ads.server";
import { DIMENSIONS, type CreativeInput, type CreativeScreenRun, type ScoreCard } from "../types";

const input: CreativeInput = {
  imageUrl: null, headline: "h", primaryText: "p", cta: "SHOP_NOW",
  destinationUrl: "https://x.test/p", audience: "a",
};

function card(composite: number): ScoreCard {
  return {
    composite, grade: "okay", confidence: "medium", summary: "s",
    metrics: DIMENSIONS.map((d) => ({ id: d.id, group: d.group, label: d.label, score: 70, reasoning: "" })),
    outcomes: {
      estimatedRoas: 2, roasLow: 1, roasHigh: 3, breakEvenRoas: 2,
      predictedCtr: 0.01, holdRate: 0.05, assumedSpendCents: 50000,
      predictedRevenueCents: 100000, mappedSku: null, skuPriceCents: null,
    },
    tips: [],
  };
}

function run(over: Partial<CreativeScreenRun>): CreativeScreenRun {
  return {
    id: "r", status: "done", source: "meta_ad", metaAdId: "ad-1",
    assumedSpendCents: 50000, scorecard: card(80), error: null,
    createdAt: "t", completedAt: "t", ...over,
  };
}

describe("loadOrScoreAdScorecards", () => {
  it("reuses a cached done run and does NOT call screen", async () => {
    const screen = vi.fn<ScoreAdsDeps["screen"]>();
    const deps: ScoreAdsDeps = {
      getLatestRunForAd: async () => run({ scorecard: card(80) }),
      screen,
    };
    const out = await loadOrScoreAdScorecards(
      "s.myshopify.com", [{ adId: "ad-1", creative: input }], 50000, deps,
    );
    expect(screen).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ adId: "ad-1", status: "done" });
    expect(out[0].scorecard?.composite).toBe(80);
  });

  it("scores+persists via screen with source meta_ad and the right metaAdId when no cache", async () => {
    const screen = vi.fn<ScoreAdsDeps["screen"]>(async (a) =>
      run({ metaAdId: a.metaAdId, scorecard: card(55) }),
    );
    const deps: ScoreAdsDeps = { getLatestRunForAd: async () => null, screen };
    const out = await loadOrScoreAdScorecards(
      "s.myshopify.com", [{ adId: "ad-9", creative: input }], 50000, deps,
    );
    expect(screen).toHaveBeenCalledTimes(1);
    expect(screen).toHaveBeenCalledWith(
      expect.objectContaining({ source: "meta_ad", metaAdId: "ad-9", assumedSpendCents: 50000 }),
    );
    expect(out[0]).toMatchObject({ adId: "ad-9", status: "done" });
    expect(out[0].scorecard?.composite).toBe(55);
  });

  it("isolates a failing ad — the other ad still returns its scorecard", async () => {
    const screen = vi.fn<ScoreAdsDeps["screen"]>(async (a) => {
      if (a.metaAdId === "bad") throw new Error("boom");
      return run({ metaAdId: a.metaAdId, scorecard: card(70) });
    });
    const deps: ScoreAdsDeps = { getLatestRunForAd: async () => null, screen };
    const out = await loadOrScoreAdScorecards(
      "s.myshopify.com",
      [{ adId: "bad", creative: input }, { adId: "good", creative: input }],
      50000, deps,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ adId: "bad", status: "error" });
    expect(out[0].error).toContain("boom");
    expect(out[0].scorecard).toBeNull();
    expect(out[1]).toMatchObject({ adId: "good", status: "done" });
    expect(out[1].scorecard?.composite).toBe(70);
  });

  it("re-scores when the cached run has a null scorecard (not a silent blank)", async () => {
    const screen = vi.fn<ScoreAdsDeps["screen"]>(async (a) =>
      run({ metaAdId: a.metaAdId, scorecard: card(42) }),
    );
    const deps: ScoreAdsDeps = {
      getLatestRunForAd: async () => run({ status: "done", scorecard: null }),
      screen,
    };
    const out = await loadOrScoreAdScorecards(
      "s.myshopify.com", [{ adId: "ad-1", creative: input }], 50000, deps,
    );
    // A null-scorecard cache is not reusable → re-score, and surface the fresh result.
    expect(screen).toHaveBeenCalledTimes(1);
    expect(out[0]).toMatchObject({ adId: "ad-1", status: "done" });
    expect(out[0].scorecard?.composite).toBe(42);
  });

  it("returns an error scorecard for an empty adId and never calls screen for it", async () => {
    const screen = vi.fn<ScoreAdsDeps["screen"]>();
    const deps: ScoreAdsDeps = { getLatestRunForAd: async () => null, screen };
    const out = await loadOrScoreAdScorecards(
      "s.myshopify.com", [{ adId: "", creative: input }], 50000, deps,
    );
    expect(screen).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ adId: "", status: "error", scorecard: null });
    expect(out[0].error).toBeTruthy();
  });
});
