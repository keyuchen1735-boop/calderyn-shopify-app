import { describe, it, expect, vi } from "vitest";
import { fetchMetaInsights, makeMetaSource } from "../ingest.server";
import type { MetaClient } from "../campaigns.server";

const SHOP = "00000000-0000-0000-0000-000000000003";
const ACCT = "act_123";

function client(insightsData: unknown[], campaignData: unknown[]): MetaClient {
  return {
    get: vi.fn(async (path: string) => {
      if (path.includes("/insights")) return { data: insightsData };
      return { data: campaignData };
    }),
    post: vi.fn(async () => ({ success: true })),
  };
}

describe("fetchMetaInsights", () => {
  it("returns normalized spend rows for the account", async () => {
    const c = client(
      [{ campaign_id: "c1", date_start: "2026-06-01", spend: "10.00", impressions: "100", clicks: "5" }],
      [],
    );
    const rows = await fetchMetaInsights(c, ACCT, SHOP, { datePreset: "last_90d" });
    expect(rows[0]).toMatchObject({ campaign_external_id: "c1", spend_cents: 1000, platform: "meta" });
    expect(c.get).toHaveBeenCalledWith(
      `/${ACCT}/insights`,
      expect.objectContaining({ level: "campaign", time_increment: "1" }),
    );
  });
});

describe("makeMetaSource", () => {
  it("fetchCampaigns maps listCampaigns output with the account currency", async () => {
    const c = client([], [
      { id: "c1", name: "Spring", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "5000" },
    ]);
    const src = makeMetaSource(c, ACCT, SHOP, "USD");
    const camps = await src.fetchCampaigns();
    expect(camps[0]).toMatchObject({ external_id: "c1", platform: "meta", currency: "USD", daily_budget_cents: 5000 });
  });

  it("fetchDailySpend requests a single-day window", async () => {
    const c = client([{ campaign_id: "c1", date_start: "2026-06-05", spend: "1.00" }], []);
    const src = makeMetaSource(c, ACCT, SHOP, "USD");
    const rows = await src.fetchDailySpend("2026-06-05");
    expect(rows[0]).toMatchObject({ day: "2026-06-05", spend_cents: 100 });
    expect(c.get).toHaveBeenCalledWith(
      `/${ACCT}/insights`,
      expect.objectContaining({ "time_range": JSON.stringify({ since: "2026-06-05", until: "2026-06-05" }) }),
    );
  });
});
