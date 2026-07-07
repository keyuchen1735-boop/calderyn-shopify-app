import { describe, it, expect } from "vitest";
import { budgetDraft } from "../drafts";

describe("budgetDraft", () => {
  it("carries the source campaign in entity_ref and the reallocation plan in evidence", () => {
    const d = budgetDraft({
      sourceCampaignId: "src", destCampaignId: "dst", sourceName: "West", destName: "East",
      amountCents: 4000, sourceRegion: "us-west", destRegion: "us-east",
      sourceScore: 0.1, destScore: 0.5, narrative: "shift budget east",
    });
    expect(d.entityRef.campaign_id).toBe("src");
    expect(d.entityRef.title).toContain("East");
    expect(d.evidence.source_campaign_id).toBe("src");
    expect(d.evidence.dest_campaign_id).toBe("dst");
    expect(d.evidence.amount_cents).toBe(4000);
    expect(d.dollarImpact).toBe(40);
  });
});
