import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadGeoSegmentedCampaigns, runWeatherSuggestForShop } from "../weather-suggest.server";
import type { RegionCode } from "../../ads/actions";
import type { RegionForecast } from "../../weather/score";

const SHOP = "11111111-1111-1111-1111-111111111111";

const CONFLICT_KEY = ["shop_id", "suggested_on", "source_campaign_id", "dest_campaign_id"] as const;

// Minimal chainable Supabase stub. weather_suggestion is modelled as a real
// in-memory table with the unique-key conflict semantics of the migration, so
// tests assert what ends up stored — including that ON CONFLICT DO NOTHING
// (ignoreDuplicates) never touches an existing row.
function fakeSb(opts: {
  /** null = shop has no guardrail_config row at all. */
  sensitivity: number | null;
  campaigns: Array<Record<string, unknown>>;
  existingSuggestions?: Array<Record<string, unknown>>;
}) {
  const table: Array<Record<string, unknown>> = (opts.existingSuggestions ?? []).map((r) => ({ ...r }));
  const calls = { upserts: [] as unknown[] };
  function builder(tableName: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.not = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () =>
      tableName === "guardrail_config" && opts.sensitivity != null
        ? { data: { weather_sensitivity: opts.sensitivity }, error: null }
        : { data: null, error: null },
    );
    chain.then = (res: (v: { data: unknown; error: null }) => void) => {
      if (tableName === "ad_campaign_dim") return Promise.resolve({ data: opts.campaigns, error: null }).then(res);
      return Promise.resolve({ data: null, error: null }).then(res);
    };
    chain.upsert = vi.fn(
      (rows: Array<Record<string, unknown>>, upsertOpts?: { ignoreDuplicates?: boolean }) => {
        calls.upserts.push(rows);
        const inserted: Array<Record<string, unknown>> = [];
        for (const row of rows) {
          const existing = table.find((t) => CONFLICT_KEY.every((k) => t[k] === row[k]));
          if (existing) {
            // Conflict: DO NOTHING when ignoreDuplicates, else DO UPDATE.
            if (!upsertOpts?.ignoreDuplicates) Object.assign(existing, row);
          } else {
            table.push({ ...row });
            inserted.push({ ...row });
          }
        }
        const result = { data: inserted, error: null };
        const ret: Record<string, unknown> = {
          select: vi.fn(() => ret),
          then: (res: (v: typeof result) => unknown) => Promise.resolve(result).then(res),
        };
        return ret;
      },
    );
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls, table };
}

const forecasts = new Map<RegionCode, RegionForecast>([
  ["us-west", { avgTempC: 28, precipMm: 0, snowCm: 0, avgDaylightH: 14 }],
  ["us-east", { avgTempC: 2, precipMm: 25, snowCm: 3, avgDaylightH: 9 }],
]);
const fetchForecasts = vi.fn(async () => forecasts);

const TWO_REGION_CAMPAIGNS = [
  { id: "w1", name: "West", status: "active", daily_budget_cents: 10000, geo_targets: ["us-west"] },
  { id: "e1", name: "East", status: "active", daily_budget_cents: 5000, geo_targets: ["us-east"] },
];

describe("runWeatherSuggestForShop", () => {
  it("skips when sensitivity is 0 (no fetch, no write)", async () => {
    const { sb, calls } = fakeSb({ sensitivity: 0, campaigns: [] });
    const ff = vi.fn(async () => forecasts);
    const r = await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts: ff, today: "2026-07-06" });
    expect(r.suggested).toBe(0);
    expect(ff).not.toHaveBeenCalled();
    expect(calls.upserts).toHaveLength(0);
  });
  it("skips a shop with no guardrail_config row at all", async () => {
    const { sb, calls } = fakeSb({ sensitivity: null, campaigns: TWO_REGION_CAMPAIGNS });
    const ff = vi.fn(async () => forecasts);
    const r = await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts: ff, today: "2026-07-06" });
    expect(r.suggested).toBe(0);
    expect(ff).not.toHaveBeenCalled();
    expect(calls.upserts).toHaveLength(0);
  });
  it("excludes zero-budget campaigns from eligibility", async () => {
    // An active $0/day campaign must not become a region's representative —
    // it would be picked as the source giver and zero out the whole move.
    const { sb } = fakeSb({
      sensitivity: 50,
      campaigns: [{ id: "z1", name: "Zero", status: "active", daily_budget_cents: 0, geo_targets: ["us-west"] }],
    });
    expect(await loadGeoSegmentedCampaigns(SHOP, sb)).toEqual([]);
  });
  it("writes a pending suggestion for a two-region shop", async () => {
    const { sb, table } = fakeSb({ sensitivity: 50, campaigns: TWO_REGION_CAMPAIGNS });
    const r = await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts, today: "2026-07-06" });
    expect(r.suggested).toBe(1);
    expect(table).toHaveLength(1);
    expect(table[0]).toMatchObject({ shop_id: SHOP, suggested_on: "2026-07-06", status: "pending" });
  });
  it("skips a shop with no geo-segmented campaigns", async () => {
    const { sb, calls } = fakeSb({
      sensitivity: 50,
      campaigns: [{ id: "n1", name: "National", status: "active", daily_budget_cents: 10000, geo_targets: [] }],
    });
    const r = await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts, today: "2026-07-06" });
    expect(r.suggested).toBe(0);
    expect(calls.upserts).toHaveLength(0);
  });
  it("never resurrects an already-actioned suggestion on a same-day re-run", async () => {
    const dismissed = {
      shop_id: SHOP,
      suggested_on: "2026-07-06",
      source_campaign_id: "w1",
      dest_campaign_id: "e1",
      status: "dismissed",
    };
    const { sb, table } = fakeSb({
      sensitivity: 50,
      campaigns: TWO_REGION_CAMPAIGNS,
      existingSuggestions: [dismissed],
    });
    const r = await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts, today: "2026-07-06" });
    expect(r.suggested).toBe(0);
    expect(table).toHaveLength(1);
    expect(table[0].status).toBe("dismissed");
  });
  it("leaves an existing pending suggestion in place without duplicating", async () => {
    const pending = {
      shop_id: SHOP,
      suggested_on: "2026-07-06",
      source_campaign_id: "w1",
      dest_campaign_id: "e1",
      status: "pending",
      amount_cents: 1234,
    };
    const { sb, table } = fakeSb({
      sensitivity: 50,
      campaigns: TWO_REGION_CAMPAIGNS,
      existingSuggestions: [pending],
    });
    const r = await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts, today: "2026-07-06" });
    expect(r.suggested).toBe(0);
    expect(table).toHaveLength(1);
    expect(table[0].status).toBe("pending");
    // The existing row's payload survives untouched — a DO UPDATE regression
    // would clobber amount_cents with the freshly computed value.
    expect(table[0].amount_cents).toBe(1234);
  });
});
