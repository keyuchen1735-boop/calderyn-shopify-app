import { describe, it, expect } from "vitest";
import { adaptScreenRun } from "../client";
import type { CreativeScreenRun, ScoreCard } from "~/lib/screener/types";

const scorecard: ScoreCard = {
  composite: 72,
  grade: "okay",
  confidence: "medium",
  summary: "Solid hook, weak offer.",
  metrics: [
    { id: "hook_strength", group: "attention", label: "Hook strength", score: 80, reasoning: "r" },
  ],
  outcomes: {
    estimatedRoas: 2.4,
    roasLow: 1.1,
    roasHigh: 3.4,
    breakEvenRoas: 2.0,
    predictedCtr: 0.012,
    holdRate: 0.05,
    assumedSpendCents: 50_000,
    predictedRevenueCents: 120_000,
    mappedSku: null,
    skuPriceCents: null,
  },
  tips: ["tip one"],
};

function run(overrides: Partial<CreativeScreenRun>): CreativeScreenRun {
  return {
    id: "r1",
    status: "done",
    source: "manual",
    metaAdId: null,
    assumedSpendCents: 50_000,
    scorecard,
    error: null,
    createdAt: "2026-06-11T00:00:00Z",
    completedAt: "2026-06-11T00:00:30Z",
    creativeInput: {
      imageUrl: "data:image/webp;base64,AA",
      mediaKind: "video",
      videoFrameUrls: ["data:image/webp;base64,AA"],
      videoDurationSec: 12,
      headline: "The tee that survives",
      primaryText: "p",
      cta: "Shop Now",
      destinationUrl: "https://x.test/p",
      audience: "a",
    },
    variants: [
      {
        mode: "copy",
        input: {
          imageUrl: null,
          headline: "Better headline",
          primaryText: "p2",
          cta: "Buy",
          destinationUrl: "https://x.test/p",
          audience: "a",
        },
        rationale: "why",
        composite: 78,
        delta: 6,
        summary: "beats it",
      },
    ],
    ...overrides,
  };
}

describe("adaptScreenRun", () => {
  it("maps a done run to the Scorecard view-model, defaulting null SKU fields", () => {
    const vm = adaptScreenRun(run({}));
    expect(vm).not.toBeNull();
    expect(vm?.ad_name).toBe("The tee that survives");
    expect(vm?.composite).toBe(72);
    expect(vm?.outcomes.mappedSku).toBe("No SKU");
    expect(vm?.outcomes.skuPriceCents).toBe(0);
    expect(vm?.metrics[0]?.label).toBe("Hook strength");
    expect(vm?.variants[0]).toEqual({
      mode: "copy",
      composite: 78,
      delta: 6,
      summary: "beats it",
      headline: "Better headline",
      cta: "Buy",
    });
  });

  it("returns null without a scorecard and falls back ad_name by source", () => {
    expect(adaptScreenRun(run({ scorecard: null }))).toBeNull();
    const meta = adaptScreenRun(
      run({ source: "meta_ad", creativeInput: null }),
    );
    expect(meta?.ad_name).toBe("Meta ad");
  });
});
