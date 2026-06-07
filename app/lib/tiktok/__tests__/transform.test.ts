import { describe, it, expect } from "vitest";
import { tiktokCampaignToNormalized, tiktokReportToSpend } from "../transform";

const SHOP = "00000000-0000-0000-0000-000000000004";

describe("tiktokCampaignToNormalized", () => {
  it("maps a TikTok campaign to NormalizedCampaign with status + budget", () => {
    const out = tiktokCampaignToNormalized(
      { campaign_id: "tk1", campaign_name: "Promo", operation_status: "ENABLE", budget: 50 },
      SHOP, "USD",
    );
    expect(out).toMatchObject({
      shop_id: SHOP, platform: "tiktok", external_id: "tk1", name: "Promo",
      status: "active", daily_budget_cents: 5000, currency: "USD",
    });
  });

  it("maps DISABLE to paused", () => {
    expect(tiktokCampaignToNormalized(
      { campaign_id: "tk2", campaign_name: "x", operation_status: "DISABLE", budget: 0 }, SHOP, "USD",
    ).status).toBe("paused");
  });
});

describe("tiktokReportToSpend", () => {
  it("flattens dimensions+metrics into a normalized spend row in cents", () => {
    const out = tiktokReportToSpend(
      {
        dimensions: { campaign_id: "tk1", stat_time_day: "2026-06-01 00:00:00" },
        metrics: { spend: "12.34", impressions: "1500", clicks: "38", conversion: "4", total_purchase_value: "199.95" },
      },
      SHOP,
    );
    expect(out).toMatchObject({
      shop_id: SHOP, campaign_external_id: "tk1", platform: "tiktok", day: "2026-06-01",
      spend_cents: 1234, impressions: 1500, clicks: 38, conversions: 4, revenue_attrib_cents: 19995,
    });
  });

  it("defaults missing metrics to 0", () => {
    const out = tiktokReportToSpend(
      { dimensions: { campaign_id: "tk9", stat_time_day: "2026-06-02 00:00:00" }, metrics: {} }, SHOP,
    );
    expect(out).toMatchObject({ spend_cents: 0, impressions: 0, clicks: 0, conversions: 0, revenue_attrib_cents: 0 });
  });
});
