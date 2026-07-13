import { describe, expect, it } from "vitest";
import type { CampaignVM } from "../../view-models";
import {
  campaignPortfolio,
  campaignStory,
  portfolioGreeting,
  roasRailPosition,
} from "../campaign-experience";

const base: CampaignVM = {
  id: "c1",
  name: "Summer story",
  platform: "Meta",
  status: "active",
  daily_budget_cents: 5000,
  spend_7d: 35000,
  roas_7d: 2.4,
  breakeven_roas: 1.6,
  contribution_margin: 0,
  grade: "winning",
  calderynScore: null,
};

describe("campaignStory", () => {
  it("reads a profitable campaign relative to its own break-even", () => {
    expect(campaignStory(base)).toMatchObject({
      health: "healthy",
      verdict: "Returning 0.8× above break-even.",
      roasDelta: 0.8,
    });
  });

  it("does not label a zero-spend campaign as a loser", () => {
    expect(campaignStory({ ...base, spend_7d: 0, roas_7d: 0 }).health).toBe("learning");
  });

  it("keeps paused state primary even when historical return is weak", () => {
    expect(campaignStory({ ...base, status: "paused", roas_7d: 0.4 }).health).toBe("paused");
  });
});

describe("campaignPortfolio", () => {
  it("counts states and excludes paused budgets", () => {
    const summary = campaignPortfolio([
      base,
      { ...base, id: "c2", status: "paused", daily_budget_cents: 9000 },
      { ...base, id: "c3", spend_7d: 0, roas_7d: 0, daily_budget_cents: 0 },
      { ...base, id: "c4", roas_7d: 1.1 },
    ]);

    expect(summary).toEqual({
      activeCount: 3,
      pausedCount: 1,
      healthyCount: 1,
      attentionCount: 1,
      learningCount: 1,
      dailyBudgetCents: 10000,
    });
    expect(portfolioGreeting(summary).title).toContain("1 campaign deserves");
  });
});

describe("roasRailPosition", () => {
  it("keeps markers inside the visual rail", () => {
    expect(roasRailPosition(0, 0)).toBe(4);
    expect(roasRailPosition(100, 1)).toBeLessThanOrEqual(96);
  });
});
