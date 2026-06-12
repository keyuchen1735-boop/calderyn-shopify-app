import { describe, it, expect, vi, afterEach } from "vitest";
import { makeTikTokSource, shopCurrencyFallback } from "../ingest.server";
import { buildTikTokClient } from "../client.server";
import type { TikTokClient } from "../client.server";
import type { TikTokReportRow, TikTokCampaignPayload } from "../types";
import { RateLimitError } from "../../ads/backoff";

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

  it("fetchBackfillSpend chunks the 90-day window into three 30-day reports", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-06-06T00:00:00Z"));
    const c = client([], []);
    const src = makeTikTokSource(c, ADV, SHOP, "USD");
    await src.fetchBackfillSpend();
    expect(c.getReport).toHaveBeenCalledTimes(3);
    expect(c.getReport).toHaveBeenNthCalledWith(1, ADV, "2026-03-08", "2026-04-07");
    expect(c.getReport).toHaveBeenNthCalledWith(2, ADV, "2026-04-07", "2026-05-07");
    expect(c.getReport).toHaveBeenNthCalledWith(3, ADV, "2026-05-07", "2026-06-06");
    vi.useRealTimers();
  });
});

// ─── buildTikTokClient pagination tests (real impl, stubbed fetch) ────────────

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

  it("returns null when currency is missing from response", async () => {
    const mockFetch = vi.fn(async () => ({
      status: 200,
      json: async () => ({ code: 0, message: "OK", data: { list: [{}] } }),
    } as Response));
    vi.stubGlobal("fetch", mockFetch);

    const c = buildTikTokClient("test-token");
    const currency = await c.getAdvertiserCurrency(ADV);
    expect(currency).toBeNull();
  });

  it("returns null when list is empty", async () => {
    const mockFetch = vi.fn(async () => ({
      status: 200,
      json: async () => ({ code: 0, message: "OK", data: { list: [] } }),
    } as Response));
    vi.stubGlobal("fetch", mockFetch);

    const c = buildTikTokClient("test-token");
    const currency = await c.getAdvertiserCurrency(ADV);
    expect(currency).toBeNull();
  });

  it("returns null when the scope is denied (non-zero code)", async () => {
    const mockFetch = vi.fn(async () => ({
      status: 200,
      json: async () => ({ code: 40001, message: "No permission", data: {} }),
    } as Response));
    vi.stubGlobal("fetch", mockFetch);

    const c = buildTikTokClient("test-token");
    const currency = await c.getAdvertiserCurrency(ADV);
    expect(currency).toBeNull();
  });
});

// TikTok intermittently returns HTTP 200 with envelope code 50002 ("Internal
// service timeout") on their own backend hiccups. These must surface as
// RateLimitError so withRetry recovers from the blip instead of failing the
// whole sync and persisting a stale error to shop_integrations.sync_error.
describe("buildTikTokClient transient-error handling", () => {
  it("throws RateLimitError (not a generic Error) on envelope code 50002", async () => {
    const mockFetch = vi.fn(async () => ({
      status: 200,
      json: async () => ({ code: 50002, message: "Internal service timeout", data: {} }),
    } as Response));
    vi.stubGlobal("fetch", mockFetch);

    const c = buildTikTokClient("test-token");
    await expect(c.getCampaigns(ADV)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("throws RateLimitError on the full 50000-59999 transient range", async () => {
    for (const code of [50000, 50001, 50003, 51000, 59999]) {
      const mockFetch = vi.fn(async () => ({
        status: 200,
        json: async () => ({ code, message: "server error", data: {} }),
      } as Response));
      vi.stubGlobal("fetch", mockFetch);
      const c = buildTikTokClient("test-token");
      await expect(c.getCampaigns(ADV)).rejects.toBeInstanceOf(RateLimitError);
    }
  });

  it("still throws a generic Error on non-transient codes (e.g. 40002 invalid arg)", async () => {
    const mockFetch = vi.fn(async () => ({
      status: 200,
      json: async () => ({ code: 40002, message: "Invalid argument", data: {} }),
    } as Response));
    vi.stubGlobal("fetch", mockFetch);

    const c = buildTikTokClient("test-token");
    await expect(c.getCampaigns(ADV)).rejects.toThrow(/TikTok campaign error/);
    await expect(c.getCampaigns(ADV)).rejects.not.toBeInstanceOf(RateLimitError);
  });
});

describe("shopCurrencyFallback", () => {
  function fakeSb(result: { data: { currency?: unknown } | null; error: unknown }) {
    const maybeSingle = vi.fn(async () => result);
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      maybeSingle,
    };
    return { from: vi.fn(() => chain) } as unknown as Parameters<typeof shopCurrencyFallback>[0];
  }

  it("returns the latest order's currency", async () => {
    const sb = fakeSb({ data: { currency: "EUR" }, error: null });
    expect(await shopCurrencyFallback(sb, SHOP)).toBe("EUR");
  });

  it("returns USD when the shop has no orders", async () => {
    const sb = fakeSb({ data: null, error: null });
    expect(await shopCurrencyFallback(sb, SHOP)).toBe("USD");
  });

  it("returns USD on query error", async () => {
    const sb = fakeSb({ data: null, error: { message: "boom" } });
    expect(await shopCurrencyFallback(sb, SHOP)).toBe("USD");
  });
});
