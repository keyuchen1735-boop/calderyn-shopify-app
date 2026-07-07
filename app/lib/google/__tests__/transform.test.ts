// TDD coverage for the Google Ads connector transforms.

import { describe, it, expect } from "vitest";
import { transformCampaign, transformReportRow, snakeKeysDeep } from "../transform";
import type { GoogleCampaignPayload, GoogleReportRow } from "../types";

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
          start_date_time: "2026-03-15",
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

describe("snakeKeysDeep", () => {
  it("rewrites nested camelCase keys to snake_case", () => {
    expect(
      snakeKeysDeep({
        campaign: { startDateTime: "2026-03-15", advertisingChannelType: "SEARCH" },
        campaignBudget: { amountMicros: "50000000" },
        customer: { currencyCode: "USD" },
      }),
    ).toEqual({
      campaign: { start_date_time: "2026-03-15", advertising_channel_type: "SEARCH" },
      campaign_budget: { amount_micros: "50000000" },
      customer: { currency_code: "USD" },
    });
  });

  it("recurses through arrays and is a no-op on already-snake_case input", () => {
    const snake = [{ metrics: { cost_micros: "10" } }];
    expect(snakeKeysDeep(snake)).toEqual(snake);
  });

  it("passes primitives through untouched", () => {
    expect(snakeKeysDeep("x")).toBe("x");
    expect(snakeKeysDeep(null)).toBeNull();
    expect(snakeKeysDeep(7)).toBe(7);
  });
});

// The Google Ads REST endpoint returns camelCase; ingest normalizes it via
// snakeKeysDeep before the transforms run. These assert the two compose so a
// real camelCase API response maps to correct spend/budget/date values.
describe("camelCase API response → normalize → transform", () => {
  it("maps a camelCase campaign row end to end", () => {
    const apiRow = {
      campaign: {
        id: "111",
        name: "Search - Brand",
        status: "ENABLED",
        advertisingChannelType: "SEARCH",
        startDateTime: "2026-01-01",
      },
      campaignBudget: { amountMicros: "50000000" },
      customer: { currencyCode: "USD" },
    };
    const out = transformCampaign(snakeKeysDeep(apiRow) as GoogleCampaignPayload, SHOP);
    expect(out).toMatchObject({
      external_id: "111",
      objective: "SEARCH",
      daily_budget_cents: 5000,
      currency: "USD",
      created_at_source: "2026-01-01",
    });
  });

  it("maps a camelCase report row's money fields correctly", () => {
    const apiRow = {
      campaign: { id: "111" },
      metrics: {
        costMicros: "12340000",
        impressions: "1500",
        clicks: "38",
        conversions: "4",
        conversionsValue: "199.95",
      },
      segments: { date: "2026-04-15" },
    };
    const out = transformReportRow(snakeKeysDeep(apiRow) as GoogleReportRow, SHOP);
    expect(out).toMatchObject({
      spend_cents: 1234,
      impressions: 1500,
      revenue_attrib_cents: 19995,
      day: "2026-04-15",
    });
  });
});
