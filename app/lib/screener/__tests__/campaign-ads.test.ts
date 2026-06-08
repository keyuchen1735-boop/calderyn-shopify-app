import { describe, it, expect, vi } from "vitest";
import {
  loadCachedAdScorecards,
  loadOrScoreAdScorecards,
  type ScoreAdsDeps,
} from "../campaign-ads.server";
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
    createdAt: "t", completedAt: "t", creativeInput: null, variants: [], ...over,
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

  it("dedupes the same adId in one batch → screen runs once, mapped to every position", async () => {
    const screen = vi.fn<ScoreAdsDeps["screen"]>(async (a) =>
      run({ metaAdId: a.metaAdId, scorecard: card(64) }),
    );
    const deps: ScoreAdsDeps = { getLatestRunForAd: async () => null, screen };
    const out = await loadOrScoreAdScorecards(
      "s.myshopify.com",
      [{ adId: "dup", creative: input }, { adId: "dup", creative: input }],
      50000, deps,
    );
    // One paid run for the duplicate ad, but both output positions filled.
    expect(screen).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ adId: "dup", status: "done" });
    expect(out[1]).toMatchObject({ adId: "dup", status: "done" });
    expect(out[0].scorecard?.composite).toBe(64);
    expect(out[1].scorecard?.composite).toBe(64);
  });
});

describe("loadCachedAdScorecards", () => {
  it("returns cached scorecards for ads that have a done run, omits uncached ads", async () => {
    const getLatestRunForAd = vi.fn(async (_shop: string, adId: string) =>
      adId === "has" ? run({ metaAdId: "has", scorecard: card(88) }) : null,
    );
    const out = await loadCachedAdScorecards("s.myshopify.com", ["has", "missing"], {
      getLatestRunForAd,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ adId: "has", status: "done" });
    expect(out[0].scorecard?.composite).toBe(88);
  });

  it("omits ads whose cached run has a null scorecard (never a silent blank)", async () => {
    const getLatestRunForAd = async () => run({ status: "done", scorecard: null });
    const out = await loadCachedAdScorecards("s.myshopify.com", ["x"], { getLatestRunForAd });
    expect(out).toHaveLength(0);
  });

  it("isolates a failing read — the other ad still returns its cached scorecard", async () => {
    const getLatestRunForAd = vi.fn(async (_shop: string, adId: string) => {
      if (adId === "bad") throw new Error("read boom");
      return run({ metaAdId: adId, scorecard: card(70) });
    });
    const out = await loadCachedAdScorecards("s.myshopify.com", ["bad", "good"], {
      getLatestRunForAd,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ adId: "good", status: "done" });
  });

  it("skips empty adIds without reading", async () => {
    const getLatestRunForAd = vi.fn(async () => null);
    const out = await loadCachedAdScorecards("s.myshopify.com", ["", ""], {
      getLatestRunForAd,
    });
    expect(getLatestRunForAd).not.toHaveBeenCalled();
    expect(out).toHaveLength(0);
  });
});
