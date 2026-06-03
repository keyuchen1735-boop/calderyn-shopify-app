import { describe, it, expect } from "vitest";
import { mapCampaignInsight, mapAdInsight, mapAdDim, mapCampaignDim } from "../mappers.server";

const SHOP = "shop-uuid";

const campaignRow = {
  campaign_id: "120",
  campaign_name: "Prospecting",
  date_start: "2026-05-01",
  date_stop: "2026-05-01",
  spend: "123.45",
  impressions: "1000",
  inline_link_clicks: "50",
  account_currency: "USD",
  actions: [
    { action_type: "omni_purchase", value: "5" },
    { action_type: "purchase", value: "9" }, // must be ignored (omni wins, no sum)
  ],
  action_values: [
    { action_type: "omni_purchase", value: "678.90" },
    { action_type: "purchase", value: "1000.00" },
  ],
};

const adRow = {
  ad_id: "777",
  ad_name: "Hero video",
  adset_id: "555",
  campaign_id: "120",
  date_start: "2026-05-01",
  date_stop: "2026-05-01",
  spend: "10.00",
  impressions: "100",
  inline_link_clicks: "4",
  account_currency: "USD",
  actions: [
    { action_type: "post_reaction", value: "12" },
    { action_type: "comment", value: "3" },
    { action_type: "post", value: "2" },
    { action_type: "onsite_conversion.post_save", value: "1" },
    { action_type: "post_engagement", value: "40" },
    { action_type: "omni_purchase", value: "1" },
  ],
  action_values: [{ action_type: "omni_purchase", value: "55.00" }],
};

describe("mapCampaignInsight", () => {
  it("maps spend/clicks/purchase, deduping omni_purchase over purchase (never both)", () => {
    expect(mapCampaignInsight(SHOP, campaignRow)).toEqual({
      shop_id: SHOP,
      campaign_external_id: "120",
      day_bucket: "2026-05-01",
      spend_cents: 12345,
      impressions: 1000,
      link_clicks: 50,
      purchases: 5,
      purchase_value_cents: 67890,
      currency: "USD",
    });
  });

  it("defaults missing money/counts to 0 and currency to USD", () => {
    const row = { campaign_id: "1", campaign_name: "x", date_start: "2026-05-02" };
    expect(mapCampaignInsight(SHOP, row)).toMatchObject({
      spend_cents: 0,
      impressions: 0,
      link_clicks: 0,
      purchases: 0,
      purchase_value_cents: 0,
      currency: "USD",
    });
  });
});

describe("mapAdInsight", () => {
  it("maps ad-level metrics and engagement columns", () => {
    expect(mapAdInsight(SHOP, adRow)).toEqual({
      shop_id: SHOP,
      ad_external_id: "777",
      campaign_external_id: "120",
      day_bucket: "2026-05-01",
      spend_cents: 1000,
      impressions: 100,
      link_clicks: 4,
      purchases: 1,
      purchase_value_cents: 5500,
      currency: "USD",
      reactions: 12,
      comments: 3,
      shares: 2,
      saves: 1,
      post_engagement: 40,
    });
  });

  it("stores 0 for engagement action types not present", () => {
    const row = { ad_id: "9", campaign_id: "1", date_start: "2026-05-02", actions: [] };
    expect(mapAdInsight(SHOP, row)).toMatchObject({
      reactions: 0,
      comments: 0,
      shares: 0,
      saves: 0,
      post_engagement: 0,
    });
  });
});

describe("dim mappers", () => {
  it("maps the ad dim", () => {
    expect(mapAdDim(SHOP, adRow)).toEqual({
      shop_id: SHOP,
      external_id: "777",
      campaign_external_id: "120",
      adset_external_id: "555",
      name: "Hero video",
    });
  });

  it("maps the campaign dim", () => {
    expect(mapCampaignDim(SHOP, campaignRow)).toEqual({
      shop_id: SHOP,
      external_id: "120",
      name: "Prospecting",
    });
  });
});
