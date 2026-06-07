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

/** Paginated fake: first call returns page1 with paging.next; second returns page2 without. */
function paginatedClient(page1Rows: unknown[], page2Rows: unknown[]): MetaClient {
  let callCount = 0;
  return {
    get: vi.fn(async (path: string) => {
      if (path.includes("/insights")) {
        callCount += 1;
        if (callCount === 1) {
          return {
            data: page1Rows,
            paging: { next: "https://graph.facebook.com/next", cursors: { after: "CURSOR1" } },
          };
        }
        return { data: page2Rows };
      }
      return { data: [] };
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

  it("fetchCampaigns threads a non-USD currency through to rows", async () => {
    const c = client([], [
      { id: "c2", name: "Euro Camp", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "2000" },
    ]);
    const src = makeMetaSource(c, ACCT, SHOP, "EUR");
    const camps = await src.fetchCampaigns();
    expect(camps[0]).toMatchObject({ currency: "EUR", platform: "meta" });
    // Note: metaAdapter.connect's currency-fetch code path (fetching /${adAccountId}?fields=currency)
    // is exercised by the real integration; the unit test here confirms makeMetaSource correctly
    // threads whatever currency it receives through to campaign rows.
  });
});

describe("fetchMetaInsights pagination", () => {
  it("follows cursor pagination and accumulates rows from all pages", async () => {
    const rowA = { campaign_id: "cA", date_start: "2026-06-01", spend: "10.00", impressions: "100", clicks: "5" };
    const rowB = { campaign_id: "cB", date_start: "2026-06-02", spend: "20.00", impressions: "200", clicks: "8" };
    const c = paginatedClient([rowA], [rowB]);

    const rows = await fetchMetaInsights(c, ACCT, SHOP, { datePreset: "last_90d" });

    // Both pages' rows must be present
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ campaign_external_id: "cA", spend_cents: 1000 });
    expect(rows[1]).toMatchObject({ campaign_external_id: "cB", spend_cents: 2000 });

    // Second call must include after: "CURSOR1"
    expect(c.get).toHaveBeenCalledTimes(2);
    expect(c.get).toHaveBeenNthCalledWith(
      2,
      `/${ACCT}/insights`,
      expect.objectContaining({ after: "CURSOR1" }),
    );
  });

  it("single-page response (no paging.next) still works as before", async () => {
    const c = client(
      [{ campaign_id: "c1", date_start: "2026-06-01", spend: "5.00", impressions: "50", clicks: "2" }],
      [],
    );
    const rows = await fetchMetaInsights(c, ACCT, SHOP, { datePreset: "last_90d" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ campaign_external_id: "c1", spend_cents: 500 });
    expect(c.get).toHaveBeenCalledTimes(1);
  });
});
