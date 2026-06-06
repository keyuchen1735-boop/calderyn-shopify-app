import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { backfillAds, pollAdsDaily } from "../ingest.server";
import type { ShopAdSource, NormalizedCampaign, NormalizedSpendRow } from "../adapter";

const SHOP = "00000000-0000-0000-0000-000000000002";

type SelectResult = { data: Array<Record<string, unknown>>; error: null };

function makeFakeSupabase(selectData: Array<Record<string, unknown>>) {
  const calls = {
    upserts: [] as Array<{ table: string; rows: unknown; opts: unknown }>,
    inserts: [] as Array<{ table: string; rows: unknown }>,
    updates: [] as Array<{ table: string; values: unknown }>,
    selectEqArgs: [] as Array<{ column: string; value: unknown }>,
    selectInArgs: [] as Array<{ column: string; values: unknown }>,
  };
  function builder(table: string, result: SelectResult) {
    const chain: Record<string, unknown> = {};
    chain.eq = vi.fn((column: string, value: unknown) => {
      calls.selectEqArgs.push({ column, value });
      return chain;
    });
    chain.in = vi.fn((column: string, values: unknown) => {
      calls.selectInArgs.push({ column, values });
      return chain;
    });
    chain.select = vi.fn(() => chain);
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
    chain.then = (resolve: (r: SelectResult) => unknown) => resolve(result);
    return chain;
  }
  const sb = {
    from: vi.fn((table: string) => builder(table, { data: selectData, error: null })),
  } as unknown as SupabaseClient;
  return { sb, calls };
}

function fakeSource(campaigns: NormalizedCampaign[], spend: NormalizedSpendRow[]): ShopAdSource {
  return {
    fetchCampaigns: vi.fn(async () => campaigns),
    fetchBackfillSpend: vi.fn(async () => spend),
    fetchDailySpend: vi.fn(async () => spend),
  };
}

const cmp = (id: string): NormalizedCampaign => ({
  shop_id: SHOP, platform: "meta", external_id: id, name: "C" + id, status: "active",
  objective: null, daily_budget_cents: null, currency: "USD", geo_targets: [], created_at_source: null,
});
const fact = (id: string, day: string, cents: number): NormalizedSpendRow => ({
  shop_id: SHOP, campaign_external_id: id, platform: "meta", day,
  spend_cents: cents, impressions: 0, clicks: 0, conversions: 0, revenue_attrib_cents: 0,
});

describe("backfillAds", () => {
  it("upserts campaign dim rows on the platform conflict key", async () => {
    const { sb, calls } = makeFakeSupabase([{ id: "u1", external_id: "1" }]);
    await backfillAds(fakeSource([cmp("1")], []), "meta", SHOP, sb);
    const dim = calls.upserts.find((u) => u.table === "ad_campaign_dim");
    expect(dim?.opts).toEqual({ onConflict: "shop_id,platform,external_id" });
    expect((dim?.rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      shop_id: SHOP, platform: "meta", external_id: "1",
    });
  });

  it("resolves spend rows to campaign uuids and upserts on campaign_id,day", async () => {
    const { sb, calls } = makeFakeSupabase([{ id: "u1", external_id: "1" }]);
    await backfillAds(fakeSource([cmp("1")], [fact("1", "2026-06-01", 1234)]), "meta", SHOP, sb);
    const f = calls.upserts.find((u) => u.table === "ad_spend_fact");
    expect(f?.opts).toEqual({ onConflict: "campaign_id,day" });
    expect((f?.rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      campaign_id: "u1", day: "2026-06-01", spend_cents: 1234,
    });
  });

  it("scopes the uuid lookup to the given platform", async () => {
    const { sb, calls } = makeFakeSupabase([{ id: "u1", external_id: "1" }]);
    await backfillAds(fakeSource([cmp("1")], [fact("1", "2026-06-01", 1)]), "meta", SHOP, sb);
    expect(calls.selectEqArgs).toContainEqual({ column: "platform", value: "meta" });
  });

  it("skips spend rows for unknown campaigns instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sb, calls } = makeFakeSupabase([{ id: "u1", external_id: "1" }]);
    await expect(
      backfillAds(fakeSource([cmp("1")], [fact("999", "2026-06-01", 5)]), "meta", SHOP, sb),
    ).resolves.toBeUndefined();
    expect(calls.upserts.find((u) => u.table === "ad_spend_fact")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown campaign 999"));
    warn.mockRestore();
  });

  it("issues a single batched `in` lookup regardless of row count", async () => {
    const { sb, calls } = makeFakeSupabase([
      { id: "u1", external_id: "1" }, { id: "u2", external_id: "2" },
    ]);
    await backfillAds(
      fakeSource([cmp("1"), cmp("2")], [
        fact("1", "2026-06-01", 1), fact("2", "2026-06-01", 2), fact("1", "2026-06-02", 3),
      ]),
      "meta", SHOP, sb,
    );
    expect(calls.selectInArgs).toHaveLength(1);
    expect(new Set(calls.selectInArgs[0].values as string[])).toEqual(new Set(["1", "2"]));
  });
});

describe("pollAdsDaily", () => {
  beforeAll(() => vi.useFakeTimers().setSystemTime(new Date("2026-06-06T00:00:00Z")));
  afterAll(() => vi.useRealTimers());

  it("uses fetchDailySpend for the given day", async () => {
    const src = fakeSource([cmp("1")], [fact("1", "2026-06-05", 7)]);
    const { sb } = makeFakeSupabase([{ id: "u1", external_id: "1" }]);
    await pollAdsDaily(src, "meta", SHOP, sb);
    expect(src.fetchDailySpend).toHaveBeenCalledWith("2026-06-05");
  });
});
