import { describe, it, expect } from "vitest";
import type {
  Platform,
  NormalizedCampaign,
  NormalizedSpendRow,
  ShopAdSource,
  AdPlatformAdapter,
} from "../adapter";

describe("adapter contract", () => {
  it("a fake adapter conforms to the contract and yields normalized rows", async () => {
    const campaign: NormalizedCampaign = {
      shop_id: "s1",
      platform: "meta",
      external_id: "c1",
      name: "Spring",
      status: "active",
      objective: "OUTCOME_SALES",
      daily_budget_cents: 5000,
      currency: "USD",
      geo_targets: [],
      created_at_source: null,
    };
    const spend: NormalizedSpendRow = {
      shop_id: "s1",
      campaign_external_id: "c1",
      platform: "meta",
      day: "2026-06-01",
      spend_cents: 1234,
      impressions: 100,
      clicks: 10,
      conversions: 2,
      revenue_attrib_cents: 9900,
    };
    const source: ShopAdSource = {
      fetchCampaigns: async () => [campaign],
      fetchBackfillSpend: async () => [spend],
      fetchDailySpend: async () => [spend],
    };
    const adapter: AdPlatformAdapter = {
      platform: "meta",
      integrationKind: "meta_ads",
      connect: async () => source,
    };

    expect(adapter.platform).toBe("meta");
    expect((await source.fetchCampaigns())[0].external_id).toBe("c1");
    expect((await source.fetchDailySpend("2026-06-01"))[0].spend_cents).toBe(1234);
    const p: Platform = adapter.platform;
    expect(p).toBe("meta");
  });
});
