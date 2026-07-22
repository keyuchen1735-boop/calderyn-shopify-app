import { describe, it, expect } from "vitest";
import { adaptCampaign } from "../client";
import type { CampaignPerformance } from "~/lib/types";
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";

const base: CampaignPerformance = {
  id: "c1", name: "Prospecting", platform: "Meta", status: "active",
  daily_budget_cents: 5000, roas_7d: 2.4, contribution_margin: 0.5, spend_7d: 12000,
  campaign_kind: "regular", sale_type: null, classification_source: "detected",
  orders: 0, revenue_cents: 0, spend_cents: 12000, profit_cents: null,
  true_roas: null, cost_complete: true, cost_sources: [],
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

  it("maps selected-window metrics and classification without coercing nulls", () => {
    const campaign: CampaignPerformance = {
      ...base,
      name: "BFCM",
      campaign_kind: "sales",
      sale_type: "Black Friday",
      classification_source: "detected",
      orders: 12,
      revenue_cents: 48000,
      spend_cents: 12000,
      profit_cents: null,
      true_roas: null,
      cost_complete: false,
      cost_sources: ["quickbooks"],
    };

    expect(adaptCampaign(campaign, [])).toMatchObject({
      campaign_kind: "sales",
      sale_type: "Black Friday",
      classification_source: "detected",
      orders: 12,
      revenue_cents: 48000,
      spend_cents: 12000,
      profit_cents: null,
      true_roas: null,
      cost_complete: false,
      cost_sources: ["quickbooks"],
    });
  });
});
