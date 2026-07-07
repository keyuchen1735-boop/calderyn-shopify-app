import { describe, it, expect } from "vitest";
import { reallocationPlanFromEvidence } from "../reallocation-plan";

describe("reallocationPlanFromEvidence", () => {
  it("reads a complete plan", () => {
    expect(reallocationPlanFromEvidence({ source_campaign_id: "s", dest_campaign_id: "d", amount_cents: 4000 }))
      .toEqual({ sourceCampaignId: "s", destCampaignId: "d", amountCents: 4000 });
  });

  it("reads a complete plan with stringified amount", () => {
    expect(reallocationPlanFromEvidence({ source_campaign_id: "s", dest_campaign_id: "d", amount_cents: "4000" }))
      .toEqual({ sourceCampaignId: "s", destCampaignId: "d", amountCents: 4000 });
  });

  it("returns null when any field missing / non-positive / equal ids", () => {
    expect(reallocationPlanFromEvidence({ source_campaign_id: "s", dest_campaign_id: "d" })).toBeNull();
    expect(reallocationPlanFromEvidence({ source_campaign_id: "s", dest_campaign_id: "d", amount_cents: 0 })).toBeNull();
    expect(reallocationPlanFromEvidence({ source_campaign_id: "x", dest_campaign_id: "x", amount_cents: 10 })).toBeNull();
    expect(reallocationPlanFromEvidence(null)).toBeNull();
  });
});
