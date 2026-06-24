// TDD coverage for the Google Ads connector transforms.

import { describe, it, expect } from "vitest";
import { transformCampaign, transformReportRow } from "../transform";

const SHOP = "00000000-0000-0000-0000-000000000002";

describe("transformCampaign (google)", () => {
  it("maps a fully-populated ENABLED campaign with budget micros", () => {
    const out = transformCampaign(
      {
        campaign: {
          id: "987654321",
          name: "Search - Branded",
          status: "ENABLED",
          advertising_channel_type: "SEARCH",
          start_date: "2026-03-15",
        },
        campaign_budget: { amount_micros: "50000000" }, // $50.00 -> 5000 cents
        customer: { currency_code: "USD" },
        geo_target_constants: ["geoTargetConstants/2840"],
      },
      SHOP,
    );

    expect(out).toEqual({
      shop_id: SHOP,
      platform: "google",
      external_id: "987654321",
      name: "Search - Branded",
      status: "active",
      objective: "SEARCH",
      daily_budget_cents: 5000,
      currency: "USD",
      geo_targets: ["geoTargetConstants/2840"],
      created_at_source: "2026-03-15",
    });
  });

  it("maps PAUSED to paused and REMOVED to archived", () => {
    expect(
      transformCampaign({ campaign: { id: 1, status: "PAUSED" } }, SHOP).status,
    ).toBe("paused");
    expect(
      transformCampaign({ campaign: { id: 1, status: "REMOVED" } }, SHOP).status,
    ).toBe("archived");
  });

  it("falls back to defaults when fields are missing", () => {
    const out = transformCampaign({}, SHOP);
    expect(out.external_id).toBe("");
    expect(out.name).toBe("");
    expect(out.status).toBe("paused");
    expect(out.objective).toBeNull();
    expect(out.daily_budget_cents).toBeNull();
    expect(out.currency).toBe("USD");
    expect(out.geo_targets).toEqual([]);
    expect(out.created_at_source).toBeNull();
  });

  it("converts numeric micros (not just string) to cents", () => {
    const out = transformCampaign(
      {
        campaign: { id: 1, status: "ENABLED" },
        campaign_budget: { amount_micros: 25_500_000 },
      },
      SHOP,
    );
    expect(out.daily_budget_cents).toBe(2550); // $25.50
  });
});

describe("transformReportRow (google)", () => {
  it("converts metrics to cents and maps segments.date", () => {
    const out = transformReportRow(
      {
        campaign: { id: "987654321" },
        metrics: {
          cost_micros: "12340000", // $12.34 -> 1234 cents
          impressions: "1500",
          clicks: "38",
          conversions: "4",
          conversions_value: "199.95",
        },
        segments: { date: "2026-04-15" },
      },
      SHOP,
    );

    expect(out).toEqual({
      shop_id: SHOP,
      campaign_external_id: "987654321",
      platform: "google",
      day: "2026-04-15",
      spend_cents: 1234,
      impressions: 1500,
      clicks: 38,
      conversions: 4,
      revenue_attrib_cents: 19995,
    });
  });

  it("defaults numeric fields when absent", () => {
    const out = transformReportRow({}, SHOP);
    expect(out.campaign_external_id).toBe("");
    expect(out.day).toBe("");
    expect(out.spend_cents).toBe(0);
    expect(out.impressions).toBe(0);
    expect(out.clicks).toBe(0);
    expect(out.conversions).toBe(0);
    expect(out.revenue_attrib_cents).toBe(0);
  });

  it("rounds fractional conversions to nearest integer", () => {
    const out = transformReportRow(
      {
        campaign: { id: "1" },
        metrics: { conversions: "3.7" },
        segments: { date: "2026-04-15" },
      },
      SHOP,
    );
    expect(out.conversions).toBe(4);
  });
});
