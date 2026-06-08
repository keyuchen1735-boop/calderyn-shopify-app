import { describe, it, expect } from "vitest";
import { buildCampaignPerformance } from "../campaign-detail.server";
import type { Campaign } from "~/lib/types";

const camp = (over: Partial<Campaign> = {}): Campaign => ({
  id: "c1",
  name: "Test",
  platform: "Meta",
  status: "active",
  daily_budget_cents: 2000,
  roas_7d: 3,
  contribution_margin: 0.5,
  spend_7d: 12345,
  ...over,
});

describe("buildCampaignPerformance", () => {
  it("derives real (margin-adjusted) ROAS from a populated campaign row", () => {
    const perf = buildCampaignPerformance(camp());
    expect(perf.available).toBe(true);
    expect(perf.spend7dCents).toBe(12345);
    expect(perf.reportedRoas).toBe(3);
    expect(perf.realRoas).toBeCloseTo(1.5); // 3 × 0.5
    expect(perf.dailyBudgetCents).toBe(2000);
  });

  it("marks performance unavailable (null, never 0) when the campaign has not been ingested", () => {
    const perf = buildCampaignPerformance(null);
    expect(perf.available).toBe(false);
    expect(perf.spend7dCents).toBeNull();
    expect(perf.reportedRoas).toBeNull();
    expect(perf.realRoas).toBeNull();
  });
});
