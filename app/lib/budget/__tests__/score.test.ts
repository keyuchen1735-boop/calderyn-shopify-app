import { describe, it, expect } from "vitest";
import {
  classify,
  toPerf,
  planCuts,
  planFeeds,
  scoreLosers,
  DEFAULT_BUDGET_CONFIG,
  type CampaignPerf,
  type Classified,
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

function classified(id: string, decision: Classified["decision"], over: Partial<CampaignPerf> = {}): Classified {
  return { campaign: perf({ id, ...over }), decision };
}

describe("planCuts", () => {
  it("cuts each loser by stepPct, clamped at the floor", () => {
    const moves = planCuts(
      [
        classified("a", "negative_unit_economics", { dailyBudgetCents: 5000 }),
        classified("b", "campaign_below_breakeven", { dailyBudgetCents: 600 }),
        classified("w", "winner", { dailyBudgetCents: 9000 }),
      ],
      DEFAULT_BUDGET_CONFIG,
    );
    // a: 5000 - 20% = 4000 (freed 1000); b: 600 - 120 = 480 < floor 500 -> 500 (freed 100); w ignored
    expect(moves).toEqual([
      { campaignId: "a", name: "Camp", fromCents: 5000, toCents: 4000, deltaCents: -1000, role: "cut", roas7d: 2.5 },
      { campaignId: "b", name: "Camp", fromCents: 600, toCents: 500, deltaCents: -100, role: "cut", roas7d: 2.5 },
    ]);
  });

  it("skips losers already at the floor (no negative or zero cut)", () => {
    const moves = planCuts([classified("a", "negative_unit_economics", { dailyBudgetCents: 500 })], DEFAULT_BUDGET_CONFIG);
    expect(moves).toEqual([]);
  });
});

describe("planFeeds", () => {
  it("feeds winners by ROAS desc, each capped at ceilingPct, until the pool is empty", () => {
    const moves = planFeeds(
      [
        classified("hi", "winner", { dailyBudgetCents: 10000, roas7d: 4 }),
        classified("lo", "winner", { dailyBudgetCents: 10000, roas7d: 3 }),
      ],
      3000, // pool $30
      DEFAULT_BUDGET_CONFIG,
    );
    // hi first: cap 2000, add 2000 -> pool 1000; lo: cap 2000, add 1000 -> pool 0
    expect(moves).toEqual([
      { campaignId: "hi", name: "Camp", fromCents: 10000, toCents: 12000, deltaCents: 2000, role: "feed", roas7d: 4 },
      { campaignId: "lo", name: "Camp", fromCents: 10000, toCents: 11000, deltaCents: 1000, role: "feed", roas7d: 3 },
    ]);
  });

  it("returns nothing when the pool is empty", () => {
    expect(planFeeds([classified("hi", "winner")], 0, DEFAULT_BUDGET_CONFIG)).toEqual([]);
  });
});

describe("scoreLosers", () => {
  it("emits one alert per loser, ranked by dollar_impact desc, with detector + severity", () => {
    const drafts = scoreLosers(
      [
        classified("small", "campaign_below_breakeven", { roas7d: 1.5, spend7dCents: 10000 }),
        classified("big", "negative_unit_economics", { roas7d: 0.5, spend7dCents: 40000 }),
        classified("win", "winner"),
      ],
      DEFAULT_BUDGET_CONFIG,
    );
    // big: $400 * (1 - 0.5/2) = $400 * 0.75 = $300 ; small: $100 * (1 - 1.5/2) = $100 * 0.25 = $25
    expect(drafts.map((d) => d.entity_ref.campaign_id)).toEqual(["big", "small"]);
    expect(drafts[0]).toMatchObject({
      detectorId: "negative_unit_economics",
      severity: "critical",
      claude_rank: 1,
      entity_ref: { campaign_id: "big", name: "Camp" },
    });
    expect(drafts[0].dollar_impact).toBeCloseTo(300);
    expect(drafts[1]).toMatchObject({ detectorId: "campaign_below_breakeven", severity: "high", claude_rank: 2 });
    expect(drafts[1].dollar_impact).toBeCloseTo(25);
    expect(drafts[0].evidence).toMatchObject({ roas7d: 0.5, spend7d_cents: 40000, target_roas: 2 });
  });

  it("returns nothing when there are no losers", () => {
    expect(scoreLosers([classified("w", "winner"), classified("h", "hold")], DEFAULT_BUDGET_CONFIG)).toEqual([]);
  });
});
