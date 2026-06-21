// Unit tests for the Google Ads ingestion with a fake GoogleAdsClient and a
// chainable fake Supabase client (mirrors the supabase-js builder surface).

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { backfillGoogle } from "../ingest.server";
import type { GoogleAdsClient } from "../client.server";

const SHOP = "00000000-0000-0000-0000-000000000002";

type SelectResult = { data: Array<Record<string, unknown>>; error: null };

// Records every operation issued against a table and resolves selects with a
// configurable result. The builder is a thenable so `await sb.from(...).x()`
// works whether the chain is a write (upsert/insert/update) or a select.
function makeFakeSupabase(selectData: Array<Record<string, unknown>>) {
  const calls = {
    upserts: [] as Array<{ table: string; rows: unknown; opts: unknown }>,
    inserts: [] as Array<{ table: string; rows: unknown }>,
    updates: [] as Array<{ table: string; values: unknown }>,
    selectInArgs: [] as Array<{ column: string; values: unknown }>,
    selectCount: 0,
  };

  function builder(table: string, result: SelectResult) {
    const chain: Record<string, unknown> = {};
    const passthrough = () => chain;
    chain.eq = vi.fn(passthrough);
    chain.in = vi.fn((column: string, values: unknown) => {
      calls.selectInArgs.push({ column, values });
      return chain;
    });
    chain.select = vi.fn(() => {
      calls.selectCount += 1;
      return chain;
    });
    chain.upsert = vi.fn((rows: unknown, opts: unknown) => {
      calls.upserts.push({ table, rows, opts });
      return chain;
    });
    chain.insert = vi.fn((rows: unknown) => {
      calls.inserts.push({ table, rows });
      return chain;
    });
    chain.update = vi.fn((values: unknown) => {
      calls.updates.push({ table, values });
      return chain;
    });
    // thenable: awaiting any chain yields the select-style result
    chain.then = (resolve: (r: SelectResult) => unknown) => resolve(result);
    return chain;
  }

  const sb = {
    from: vi.fn((table: string) => builder(table, { data: selectData, error: null })),
  } as unknown as SupabaseClient;

  return { sb, calls };
}

function fakeClient(campaignRows: unknown[], reportRows: unknown[]): GoogleAdsClient {
  // CAMPAIGN_GAQL has no metrics; the report GAQL selects metrics.cost_micros.
  const search = vi.fn(async (gaql: string) =>
    gaql.includes("metrics.cost_micros") ? reportRows : campaignRows,
  );
  return { search };
}

describe("backfillGoogle", () => {
  it("upserts campaign dim rows with mapped fields", async () => {
    const campaigns = [
      {
        campaign: {
          id: "111",
          name: "Search - Brand",
          status: "ENABLED",
          advertising_channel_type: "SEARCH",
          start_date: "2026-01-01",
        },
        campaign_budget: { amount_micros: "50000000" },
        customer: { currency_code: "USD" },
      },
    ];
    const { sb, calls } = makeFakeSupabase([{ id: "uuid-111", external_id: "111" }]);
    await backfillGoogle(fakeClient(campaigns, []), SHOP, sb);

    const dimUpsert = calls.upserts.find((u) => u.table === "ad_campaign_dim");
    expect(dimUpsert).toBeDefined();
    expect(dimUpsert?.opts).toEqual({ onConflict: "shop_id,platform,external_id" });
    const rows = dimUpsert?.rows as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      shop_id: SHOP,
      platform: "google",
      external_id: "111",
      name: "Search - Brand",
      status: "active",
      objective: "SEARCH",
      daily_budget_cents: 5000,
      currency: "USD",
    });
  });

  it("resolves report rows to campaign uuids and upserts spend facts", async () => {
    const campaigns = [{ campaign: { id: "111", status: "ENABLED" } }];
    const report = [
      {
        campaign: { id: "111" },
        metrics: { cost_micros: "12340000", impressions: "1500", clicks: "38", conversions: "4" },
        segments: { date: "2026-04-15" },
      },
    ];
    const { sb, calls } = makeFakeSupabase([{ id: "uuid-111", external_id: "111" }]);
    await backfillGoogle(fakeClient(campaigns, report), SHOP, sb);

    const factUpsert = calls.upserts.find((u) => u.table === "ad_spend_fact");
    expect(factUpsert).toBeDefined();
    expect(factUpsert?.opts).toEqual({ onConflict: "campaign_id,day" });
    const rows = factUpsert?.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shop_id: SHOP,
      campaign_id: "uuid-111",
      day: "2026-04-15",
      spend_cents: 1234,
      impressions: 1500,
      clicks: 38,
      conversions: 4,
    });
  });

  it("skips report rows referencing unknown campaigns instead of throwing", async () => {
    const campaigns = [{ campaign: { id: "111", status: "ENABLED" } }];
    const report = [
      {
        campaign: { id: "999" }, // not present in the lookup result
        metrics: { cost_micros: "1000000" },
        segments: { date: "2026-04-15" },
      },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // lookup returns only campaign 111, so 999 is unknown
    const { sb, calls } = makeFakeSupabase([{ id: "uuid-111", external_id: "111" }]);

    await expect(backfillGoogle(fakeClient(campaigns, report), SHOP, sb)).resolves.toBeUndefined();

    const factUpsert = calls.upserts.find((u) => u.table === "ad_spend_fact");
    expect(factUpsert).toBeUndefined(); // nothing resolved -> no fact upsert
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown campaign 999"));
    warn.mockRestore();
  });

  it("flags a dead refresh token (invalid_grant) as reauth, not a generic error", async () => {
    const throwing: GoogleAdsClient = {
      search: vi.fn(async () => {
        throw new Error(
          "Google OAuth token exchange failed (invalid_grant): Token has been expired or revoked.",
        );
      }),
    };
    const { sb, calls } = makeFakeSupabase([]);

    await expect(backfillGoogle(throwing, SHOP, sb)).rejects.toThrow(/invalid_grant/);

    const statusUpdate = calls.updates.find((u) => u.table === "shop_integrations");
    expect((statusUpdate?.values as Record<string, unknown>).sync_status).toBe("reauth");
  });

  it("records a generic sync failure as error, not reauth", async () => {
    const throwing: GoogleAdsClient = {
      search: vi.fn(async () => {
        throw new Error("Google Ads API error: HTTP 500");
      }),
    };
    const { sb, calls } = makeFakeSupabase([]);

    await expect(backfillGoogle(throwing, SHOP, sb)).rejects.toThrow(/HTTP 500/);

    const statusUpdate = calls.updates.find((u) => u.table === "shop_integrations");
    expect((statusUpdate?.values as Record<string, unknown>).sync_status).toBe("error");
  });

  it("issues a single batched `in` lookup, not one query per report row", async () => {
    const campaigns = [
      { campaign: { id: "111", status: "ENABLED" } },
      { campaign: { id: "222", status: "ENABLED" } },
    ];
    const report = [
      { campaign: { id: "111" }, metrics: { cost_micros: "1000000" }, segments: { date: "2026-04-15" } },
      { campaign: { id: "222" }, metrics: { cost_micros: "2000000" }, segments: { date: "2026-04-15" } },
      { campaign: { id: "111" }, metrics: { cost_micros: "3000000" }, segments: { date: "2026-04-16" } },
    ];
    const { sb, calls } = makeFakeSupabase([
      { id: "uuid-111", external_id: "111" },
      { id: "uuid-222", external_id: "222" },
    ]);

    await backfillGoogle(fakeClient(campaigns, report), SHOP, sb);

    expect(calls.selectInArgs).toHaveLength(1);
    expect(calls.selectInArgs[0].column).toBe("external_id");
    expect(new Set(calls.selectInArgs[0].values as string[])).toEqual(new Set(["111", "222"]));

    const factUpsert = calls.upserts.find((u) => u.table === "ad_spend_fact");
    const rows = factUpsert?.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
  });
});
