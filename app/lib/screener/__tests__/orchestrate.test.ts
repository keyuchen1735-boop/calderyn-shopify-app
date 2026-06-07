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
    createdAt: "t", completedAt: null,
  };
  return {
    resolveSku: () => "SKU1",
    loadCalibrationInputs: async () => calib,
    scoreCreative: async () => ({
      summary: "ok",
      metrics: DIMENSIONS.map((d) => ({ id: d.id, group: d.group, label: d.label, score: 70, reasoning: "" })),
      tips: ["t"],
    }),
    startRun: async () => run,
    completeRun: async (_id, scorecard) => ({ ...run, status: "done", scorecard }),
    failRun: async (_id, message) => ({ ...run, status: "error", error: message }),
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
});
