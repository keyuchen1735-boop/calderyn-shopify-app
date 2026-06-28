import { describe, it, expect, vi } from "vitest";
import {
  pickWeakestScoredAd,
  regenerateCampaignCreative,
  type RegenerateDeps,
} from "../campaign-regen.server";
import { DIMENSIONS, type CreativeInput, type CreativeScreenRun, type ScoreCard } from "../types";
import type { AdScorecard } from "../campaign-ads.server";
import type { CreativeGenerator } from "../generate.server";

const creative: CreativeInput = {
  imageUrl: null, headline: "Old headline", primaryText: "Old body", cta: "SHOP_NOW",
  destinationUrl: "https://x.test/p", audience: "a",
};

function card(composite: number): ScoreCard {
  return {
    composite, grade: "okay", confidence: "medium", summary: "s",
    metrics: DIMENSIONS.map((d) => ({ id: d.id, group: d.group, label: d.label, score: composite, reasoning: "weak" })),
    outcomes: {
      estimatedRoas: 2, roasLow: 1, roasHigh: 3, breakEvenRoas: 2, predictedCtr: 0.01,
      holdRate: 0.05, assumedSpendCents: 50000, predictedRevenueCents: 100000,
      mappedSku: null, skuPriceCents: null,
    },
    tips: [],
  };
}

function adCard(adId: string, composite: number): AdScorecard {
  return { adId, status: "done", scorecard: card(composite), error: null };
}

function seedRun(over: Partial<CreativeScreenRun> = {}): CreativeScreenRun {
  return {
    id: "run-weak", status: "done", source: "meta_ad", metaAdId: "ad-weak",
    assumedSpendCents: 50000, scorecard: card(40), error: null, createdAt: "t",
    completedAt: "t", creativeInput: creative, variants: [], ...over,
  };
}

function fakeGenerator(): CreativeGenerator {
  return {
    mode: "copy",
    available: () => true,
    generate: vi.fn(async () => [
      { input: { ...creative, headline: "Better A" }, rationale: "fix hook" },
      { input: { ...creative, headline: "Better B" }, rationale: "fix cta" },
    ]),
  };
}

function deps(over: Partial<RegenerateDeps> = {}): RegenerateDeps {
  return {
    loadCached: async () => [adCard("ad-strong", 80), adCard("ad-weak", 40)],
    getLatestRunForAd: async () => seedRun(),
    gate: {
      generator: fakeGenerator(),
      // fake scoreOne: "Better A" beats baseline (40); "Better B" regresses.
      scoreOne: async (input: CreativeInput) => ({
        composite: input.headline === "Better A" ? 72 : 30,
        summary: "rescored", metrics: card(0).metrics,
      }),
    },
    styleRefs: ["Winning Ad 1"],
    saveVariants: vi.fn(async (_s: string, runId: string) => seedRun({ id: runId })),
    ...over,
  };
}

describe("pickWeakestScoredAd", () => {
  it("returns the lowest-composite done ad", () => {
    expect(pickWeakestScoredAd([adCard("a", 80), adCard("b", 40), adCard("c", 60)])?.adId).toBe("b");
  });
  it("ignores error rows and returns null when none are scored", () => {
    const err: AdScorecard = { adId: "e", status: "error", scorecard: null, error: "x" };
    expect(pickWeakestScoredAd([err])).toBeNull();
    expect(pickWeakestScoredAd([])).toBeNull();
  });
});

describe("regenerateCampaignCreative", () => {
  it("seeds from the weakest ad, keeps only winners, persists, returns ranked", async () => {
    const d = deps();
    const out = await regenerateCampaignCreative("s.myshopify.com", ["ad-strong", "ad-weak"], d);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.weakestAdId).toBe("ad-weak");
    expect(out.runId).toBe("run-weak");
    expect(out.variants).toHaveLength(1);
    expect(out.variants[0].input.headline).toBe("Better A");
    expect(out.variants[0].composite).toBe(72);
    expect(out.variants[0].delta).toBe(32); // 72 - baseline 40
    expect(out.discarded).toBe(1);
    expect(d.saveVariants).toHaveBeenCalledWith("s.myshopify.com", "run-weak", out.variants);
  });

  it("returns no_scored_ads when nothing is cached", async () => {
    const out = await regenerateCampaignCreative("s", ["x"], deps({ loadCached: async () => [] }));
    expect(out).toEqual({ ok: false, reason: "no_scored_ads" });
  });

  it("returns no_seed_run when the weakest ad has no reusable run", async () => {
    const out = await regenerateCampaignCreative("s", ["x"], deps({ getLatestRunForAd: async () => null }));
    expect(out).toEqual({ ok: false, reason: "no_seed_run" });
  });

  it("returns generator_unavailable and never saves when the generator is off", async () => {
    const save = vi.fn();
    const offGen: CreativeGenerator = { mode: "copy", available: () => false, generate: vi.fn() };
    const out = await regenerateCampaignCreative("s", ["x"], deps({
      gate: { generator: offGen, scoreOne: async () => ({ composite: 0, summary: "", metrics: [] }) },
      saveVariants: save,
    }));
    expect(out).toEqual({ ok: false, reason: "generator_unavailable" });
    expect(save).not.toHaveBeenCalled();
  });
});
