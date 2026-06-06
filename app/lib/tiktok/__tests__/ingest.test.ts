import { describe, it, expect, vi, afterEach } from "vitest";
import { makeTikTokSource } from "../ingest.server";
import { buildTikTokClient } from "../client.server";
import type { TikTokClient } from "../client.server";
import type { TikTokReportRow, TikTokCampaignPayload } from "../types";

const SHOP = "00000000-0000-0000-0000-000000000004";
const ADV = "adv_123";

function client(report: TikTokReportRow[], campaigns: TikTokCampaignPayload[]): TikTokClient {
  return {
    getReport: vi.fn(async () => report),
    getCampaigns: vi.fn(async () => campaigns),
    getAdvertiserCurrency: vi.fn(async () => "USD"),
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

// ─── buildTikTokClient pagination tests (real impl, stubbed fetch) ────────────

const API_BASE = "https://business-api.tiktok.com/open_api/v1.3";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildTikTokClient.getReport pagination", () => {
  it("accumulates rows across multiple pages", async () => {
    const row1: TikTokReportRow = { dimensions: { campaign_id: "c1", stat_time_day: "2026-06-01 00:00:00" }, metrics: { spend: "1.00" } };
    const row2: TikTokReportRow = { dimensions: { campaign_id: "c2", stat_time_day: "2026-06-02 00:00:00" }, metrics: { spend: "2.00" } };

    const page1Response = {
      code: 0,
      message: "OK",
      data: { list: [row1], page_info: { page: 1, page_size: 1000, total_number: 2, total_page: 2 } },
    };
    const page2Response = {
      code: 0,
      message: "OK",
      data: { list: [row2], page_info: { page: 2, page_size: 1000, total_number: 2, total_page: 2 } },
    };

    let callCount = 0;
    const mockFetch = vi.fn(async (url: string) => {
      callCount += 1;
      const body = callCount === 1 ? page1Response : page2Response;
      return { status: 200, json: async () => body } as Response;
    });
    vi.stubGlobal("fetch", mockFetch);

    const c = buildTikTokClient("test-token");
    const rows = await c.getReport(ADV, "2026-06-01", "2026-06-02");

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ dimensions: { campaign_id: "c1" } });
    expect(rows[1]).toMatchObject({ dimensions: { campaign_id: "c2" } });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // page param must increase with each call
    const firstUrl = mockFetch.mock.calls[0][0] as string;
    const secondUrl = mockFetch.mock.calls[1][0] as string;
    expect(firstUrl).toContain("page=1");
    expect(secondUrl).toContain("page=2");
  });
});

describe("buildTikTokClient.getAdvertiserCurrency", () => {
  it("returns the currency from the API", async () => {
    const mockFetch = vi.fn(async () => ({
      status: 200,
      json: async () => ({ code: 0, message: "OK", data: { list: [{ currency: "EUR" }] } }),
    } as Response));
    vi.stubGlobal("fetch", mockFetch);

    const c = buildTikTokClient("test-token");
    const currency = await c.getAdvertiserCurrency(ADV);
    expect(currency).toBe("EUR");
  });

  it("falls back to USD when currency is missing from response", async () => {
    const mockFetch = vi.fn(async () => ({
      status: 200,
      json: async () => ({ code: 0, message: "OK", data: { list: [{}] } }),
    } as Response));
    vi.stubGlobal("fetch", mockFetch);

    const c = buildTikTokClient("test-token");
    const currency = await c.getAdvertiserCurrency(ADV);
    expect(currency).toBe("USD");
  });

  it("falls back to USD when list is empty", async () => {
    const mockFetch = vi.fn(async () => ({
      status: 200,
      json: async () => ({ code: 0, message: "OK", data: { list: [] } }),
    } as Response));
    vi.stubGlobal("fetch", mockFetch);

    const c = buildTikTokClient("test-token");
    const currency = await c.getAdvertiserCurrency(ADV);
    expect(currency).toBe("USD");
  });
});
