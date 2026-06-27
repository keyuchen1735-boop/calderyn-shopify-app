import { describe, it, expect } from "vitest";
import { adaptCampaign } from "../client";
import type { Campaign } from "~/lib/types";
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";

const base: Campaign = {
  id: "c1", name: "Prospecting", platform: "Meta", status: "active",
  daily_budget_cents: 5000, roas_7d: 2.4, contribution_margin: 0.5, spend_7d: 12000,
};

describe("adaptCampaign — calderynScore threading", () => {
  it("copies calderynScore from the DTO onto the view-model", () => {
    const score: CampaignCalderynScore = {
      value: 72, band: "fair", performance: 80, creative: 50, confidence: "high",
      weakDimensions: [], tips: [], adsCovered: 2, adsTotal: 3,
    };
    const vm = adaptCampaign({ ...base, calderynScore: score }, []);
    expect(vm.calderynScore).toEqual(score);
  });

  it("defaults calderynScore to null when the DTO omits it", () => {
    const vm = adaptCampaign(base, []);
    expect(vm.calderynScore).toBeNull();
  });
});
