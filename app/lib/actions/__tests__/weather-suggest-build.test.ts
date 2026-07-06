import { describe, it, expect } from "vitest";
import { buildSuggestion, type EligibleCampaign } from "../weather-suggest.server";
import type { RegionCode } from "../../ads/actions";

const camp = (id: string, region: RegionCode, budget: number, name: string): EligibleCampaign => ({
  campaignId: id, region, dailyBudgetCents: budget, name,
});
const scores = new Map<RegionCode, number>([
  ["us-west", 0.20], ["us-central", 0.30], ["us-south", 0.25], ["us-east", 0.80],
]);

describe("buildSuggestion", () => {
  it("moves budget from the lowest-score region campaign to the highest", () => {
    const s = buildSuggestion([camp("w1", "us-west", 10000, "West"), camp("e1", "us-east", 5000, "East")], scores, 50);
    expect(s).not.toBeNull();
    expect(s!.sourceCampaignId).toBe("w1");
    expect(s!.destCampaignId).toBe("e1");
    expect(s!.amountCents).toBe(3000);
    expect(s!.sourceRegion).toBe("us-west");
    expect(s!.destRegion).toBe("us-east");
    expect(s!.narrative).toContain("West");
    expect(s!.narrative).toContain("East");
  });
  it("returns null when the score gap is below the noise floor", () => {
    const flat = new Map<RegionCode, number>([["us-west", 0.40], ["us-central", 0.41], ["us-south", 0.42], ["us-east", 0.50]]);
    expect(buildSuggestion([camp("w1", "us-west", 10000, "W"), camp("e1", "us-east", 5000, "E")], flat, 50)).toBeNull();
  });
  it("returns null at sensitivity 0 (feature off)", () => {
    expect(buildSuggestion([camp("w1", "us-west", 10000, "W"), camp("e1", "us-east", 5000, "E")], scores, 0)).toBeNull();
  });
  it("returns null when fewer than two regions are represented", () => {
    expect(buildSuggestion([camp("w1", "us-west", 10000, "W"), camp("w2", "us-west", 5000, "W2")], scores, 50)).toBeNull();
  });
  it("clamps the move below the source budget", () => {
    const s = buildSuggestion([camp("w1", "us-west", 1000, "W"), camp("e1", "us-east", 5000, "E")], scores, 100);
    expect(s!.amountCents).toBeLessThan(1000);
  });
  it("returns null when the sized amount is below the $1 floor", () => {
    const s = buildSuggestion([camp("w1", "us-west", 100, "W"), camp("e1", "us-east", 5000, "E")], scores, 1);
    expect(s).toBeNull();
  });
  it("picks the highest-budget campaign in the source region as the giver", () => {
    const s = buildSuggestion([camp("w1", "us-west", 4000, "Small"), camp("w2", "us-west", 12000, "Big"), camp("e1", "us-east", 5000, "E")], scores, 50);
    expect(s!.sourceCampaignId).toBe("w2");
  });
});
