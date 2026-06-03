import { describe, it, expect } from "vitest";
import {
  classify,
  toPerf,
  DEFAULT_BUDGET_CONFIG,
  type CampaignPerf,
} from "../score.server";
import type { MetaCampaign } from "../../meta/campaigns.server";

function perf(over: Partial<CampaignPerf>): CampaignPerf {
  return {
    id: "c1",
    name: "Camp",
    status: "ACTIVE",
    dailyBudgetCents: 5000,
    hasCampaignBudget: true,
    spend7dCents: 10000,
    roas7d: 2.5,
    ...over,
  };
}

describe("toPerf", () => {
  it("merges live campaigns with insights, defaulting missing insights to 0", () => {
    const campaigns: MetaCampaign[] = [
      { id: "c1", name: "A", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudgetCents: 5000 },
      { id: "c2", name: "B", status: "PAUSED", effectiveStatus: "PAUSED", dailyBudgetCents: null },
    ];
    const out = toPerf(campaigns, { c1: { spend7dCents: 10000, roas7d: 3.1 } });
    expect(out[0]).toEqual({
      id: "c1", name: "A", status: "ACTIVE",
      dailyBudgetCents: 5000, hasCampaignBudget: true, spend7dCents: 10000, roas7d: 3.1,
    });
    expect(out[1]).toMatchObject({ hasCampaignBudget: false, spend7dCents: 0, roas7d: 0 });
  });
});

describe("classify", () => {
  it("skips ineligible campaigns (paused / no campaign budget / below min spend)", () => {
    const out = classify(
      [
        perf({ id: "p", status: "PAUSED" }),
        perf({ id: "nb", hasCampaignBudget: false }),
        perf({ id: "low", spend7dCents: 100 }),
      ],
      DEFAULT_BUDGET_CONFIG,
    );
    expect(out.map((c) => c.decision)).toEqual(["skip", "skip", "skip"]);
  });

  it("classifies against the target ROAS bands (target 2.0)", () => {
    const out = classify(
      [
        perf({ id: "neg", roas7d: 0.7 }),
        perf({ id: "below", roas7d: 1.5 }),
        perf({ id: "hold", roas7d: 2.0 }),
        perf({ id: "win", roas7d: 3.0 }),
      ],
      DEFAULT_BUDGET_CONFIG,
    );
    expect(out.map((c) => c.decision)).toEqual([
      "negative_unit_economics",
      "campaign_below_breakeven",
      "hold",
      "winner",
    ]);
  });

  it("treats the band edges as hold (target*0.9 and target*1.2)", () => {
    const out = classify(
      [perf({ id: "loEdge", roas7d: 1.8 }), perf({ id: "hiEdge", roas7d: 2.4 })],
      DEFAULT_BUDGET_CONFIG,
    );
    expect(out.map((c) => c.decision)).toEqual(["hold", "hold"]);
  });
});
