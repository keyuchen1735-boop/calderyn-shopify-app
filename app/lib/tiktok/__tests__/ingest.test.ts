import { describe, it, expect, vi } from "vitest";
import { makeTikTokSource } from "../ingest.server";
import type { TikTokClient } from "../client.server";
import type { TikTokReportRow, TikTokCampaignPayload } from "../types";

const SHOP = "00000000-0000-0000-0000-000000000004";
const ADV = "adv_123";

function client(report: TikTokReportRow[], campaigns: TikTokCampaignPayload[]): TikTokClient {
  return {
    getReport: vi.fn(async () => report),
    getCampaigns: vi.fn(async () => campaigns),
  };
}

describe("makeTikTokSource", () => {
  it("fetchCampaigns maps campaign payloads", async () => {
    const c = client([], [{ campaign_id: "tk1", campaign_name: "Promo", operation_status: "ENABLE", budget: 50 } as TikTokCampaignPayload]);
    const src = makeTikTokSource(c, ADV, SHOP, "USD");
    const camps = await src.fetchCampaigns();
    expect(camps[0]).toMatchObject({ external_id: "tk1", platform: "tiktok", daily_budget_cents: 5000 });
  });

  it("fetchDailySpend maps a single day's report rows", async () => {
    const c = client(
      [{ dimensions: { campaign_id: "tk1", stat_time_day: "2026-06-05 00:00:00" }, metrics: { spend: "2.00" } } as TikTokReportRow],
      [],
    );
    const src = makeTikTokSource(c, ADV, SHOP, "USD");
    const rows = await src.fetchDailySpend("2026-06-05");
    expect(rows[0]).toMatchObject({ day: "2026-06-05", spend_cents: 200, platform: "tiktok" });
    expect(c.getReport).toHaveBeenCalledWith(ADV, "2026-06-05", "2026-06-05");
  });

  it("fetchBackfillSpend requests a ~90-day window ending today", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-06-06T00:00:00Z"));
    const c = client([], []);
    const src = makeTikTokSource(c, ADV, SHOP, "USD");
    await src.fetchBackfillSpend();
    expect(c.getReport).toHaveBeenCalledWith(ADV, "2026-03-08", "2026-06-06");
    vi.useRealTimers();
  });
});
