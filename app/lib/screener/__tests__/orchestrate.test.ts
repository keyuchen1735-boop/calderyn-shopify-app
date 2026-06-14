import { describe, it, expect } from "vitest";
import { executeScreen, type ScreenDeps } from "../orchestrate.server";
import { DIMENSIONS, type CreativeInput, type CalibrationInputs, type CreativeScreenRun } from "../types";

const input: CreativeInput = {
  imageUrl: null, headline: "h", primaryText: "p", cta: "SHOP_NOW",
  destinationUrl: "https://x.test/p?utm_campaign=spring", audience: "a",
};

const calib: CalibrationInputs = {
  accountBaselineCtr: 0.01, accountBaselineCpmCents: 1500, accountEngagementRate: 0.05,
  breakEvenRoas: 1.9, mappedSku: "SKU1", skuPriceCents: 4200, skuCvr: 0.02,
  topAdNames: ["A"], historyAdCount: 23,
};

function deps(over: Partial<ScreenDeps> = {}): ScreenDeps {
  const run: CreativeScreenRun = {
    id: "run-1", status: "running", source: "manual", metaAdId: null,
    assumedSpendCents: 50000, scorecard: null, error: null,
    createdAt: "t", completedAt: null, creativeInput: null, variants: [],
  };
  return {
    resolveSku: () => "SKU1",
    loadCalibrationInputs: async () => calib,
    scoreCreative: async () => ({
      summary: "ok",
      metrics: DIMENSIONS.map((d) => ({ id: d.id, group: d.group, label: d.label, score: 70, reasoning: "" })),
      tips: [{ title: "t", detail: "" }],
    }),
    startRun: async () => run,
    completeRun: async (_shop, _id, scorecard) => ({ ...run, status: "done", scorecard }),
    failRun: async (_shop, _id, message) => ({ ...run, status: "error", error: message }),
    ...over,
  };
}

describe("executeScreen", () => {
  it("scores, calibrates, persists, and returns a done run with a full scorecard", async () => {
    const out = await executeScreen({ shop: "s.myshopify.com", input, assumedSpendCents: 50000 }, deps());
    expect(out.status).toBe("done");
    expect(out.scorecard?.metrics).toHaveLength(13);
    expect(out.scorecard?.outcomes.estimatedRoas).toBeGreaterThan(0);
    expect(out.scorecard?.grade).toBe("okay");
  });

  it("returns an error run (not a throw) when scoring fails after the run is started", async () => {
    const failing = deps({ scoreCreative: async () => { throw new Error("boom"); } });
    const out = await executeScreen({ shop: "s", input, assumedSpendCents: 50000 }, failing);
    expect(out.status).toBe("error");
    expect(out.error).toContain("boom");
  });

  it("threads source and metaAdId into the run", async () => {
    const captured: { source?: string } = {};
    const out = await executeScreen(
      { shop: "s", input, assumedSpendCents: 50000, source: "meta_ad", metaAdId: "ad-9" },
      deps({
        startRun: async (_shop, source) => {
          captured.source = source;
          return {
            id: "run-9", status: "running", source, metaAdId: "ad-9",
            assumedSpendCents: 50000, scorecard: null, error: null, createdAt: "t", completedAt: null,
            creativeInput: null, variants: [],
          };
        },
        completeRun: async (_shop, _id, scorecard) => ({
          id: "run-9", status: "done", source: "meta_ad", metaAdId: "ad-9",
          assumedSpendCents: 50000, scorecard, error: null, createdAt: "t", completedAt: "t2",
          creativeInput: null, variants: [],
        }),
      }),
    );
    expect(captured.source).toBe("meta_ad");
    expect(out.metaAdId).toBe("ad-9");
    expect(out.status).toBe("done");
  });
});
