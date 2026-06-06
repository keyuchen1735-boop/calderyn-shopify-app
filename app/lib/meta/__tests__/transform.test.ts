import { describe, it, expect } from "vitest";
import { metaCampaignToNormalized, metaInsightToSpend } from "../transform";

const SHOP = "00000000-0000-0000-0000-000000000003";

describe("metaCampaignToNormalized", () => {
  it("maps a MetaCampaign to a NormalizedCampaign", () => {
    const out = metaCampaignToNormalized(
      { id: "c1", name: "Spring", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudgetCents: 5000 },
      SHOP, "USD",
    );
    expect(out).toMatchObject({
      shop_id: SHOP, platform: "meta", external_id: "c1", name: "Spring",
      status: "active", daily_budget_cents: 5000, currency: "USD",
    });
  });

  it("maps PAUSED/ARCHIVED statuses", () => {
    expect(metaCampaignToNormalized(
      { id: "c2", name: "x", status: "PAUSED", effectiveStatus: "PAUSED", dailyBudgetCents: null }, SHOP, "USD",
    ).status).toBe("paused");
    expect(metaCampaignToNormalized(
      { id: "c3", name: "x", status: "ARCHIVED", effectiveStatus: "ARCHIVED", dailyBudgetCents: null }, SHOP, "USD",
    ).status).toBe("archived");
  });
});

describe("metaInsightToSpend", () => {
  it("converts spend major-units to cents and reads purchase actions/values", () => {
    const out = metaInsightToSpend(
      {
        campaign_id: "c1",
        date_start: "2026-06-01",
        spend: "12.34",
        impressions: "1500",
        clicks: "38",
        actions: [{ action_type: "purchase", value: "4" }],
        action_values: [{ action_type: "purchase", value: "199.95" }],
      },
      SHOP,
    );
    expect(out).toMatchObject({
      shop_id: SHOP, campaign_external_id: "c1", platform: "meta", day: "2026-06-01",
      spend_cents: 1234, impressions: 1500, clicks: 38, conversions: 4, revenue_attrib_cents: 19995,
    });
  });

  it("defaults missing metrics to 0, never NaN", () => {
    const out = metaInsightToSpend({ campaign_id: "c9", date_start: "2026-06-02" }, SHOP);
    expect(out).toMatchObject({ spend_cents: 0, impressions: 0, clicks: 0, conversions: 0, revenue_attrib_cents: 0 });
  });
});
