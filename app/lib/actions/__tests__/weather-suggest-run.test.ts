import { describe, it, expect, vi } from "vitest";
import { runWeatherSuggestForShop } from "../weather-suggest.server";
import type { RegionCode } from "../../ads/actions";
import type { RegionForecast } from "../../weather/score";

const SHOP = "11111111-1111-1111-1111-111111111111";

function fakeSb(opts: { sensitivity: number; campaigns: Array<Record<string, unknown>> }) {
  const calls = { upserts: [] as unknown[] };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.not = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () =>
      table === "guardrail_config"
        ? { data: { weather_sensitivity: opts.sensitivity }, error: null }
        : { data: null, error: null },
    );
    chain.then = (res: (v: { data: unknown; error: null }) => void) => {
      if (table === "ad_campaign_dim") return Promise.resolve({ data: opts.campaigns, error: null }).then(res);
      return Promise.resolve({ data: null, error: null }).then(res);
    };
    chain.upsert = vi.fn((rows: unknown) => {
      calls.upserts.push(rows);
      return { select: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: { id: "s1" }, error: null })) })) };
    });
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as import("@supabase/supabase-js").SupabaseClient;
  return { sb, calls };
}

const forecasts = new Map<RegionCode, RegionForecast>([
  ["us-west", { avgTempC: 28, precipMm: 0, snowCm: 0, avgDaylightH: 14 }],
  ["us-east", { avgTempC: 2, precipMm: 25, snowCm: 3, avgDaylightH: 9 }],
]);
const fetchForecasts = vi.fn(async () => forecasts);

describe("runWeatherSuggestForShop", () => {
  it("skips when sensitivity is 0 (no fetch, no write)", async () => {
    const { sb, calls } = fakeSb({ sensitivity: 0, campaigns: [] });
    const ff = vi.fn(async () => forecasts);
    const r = await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts: ff, today: "2026-07-06" });
    expect(r.suggested).toBe(0);
    expect(ff).not.toHaveBeenCalled();
    expect(calls.upserts).toHaveLength(0);
  });
  it("upserts a suggestion for a two-region shop", async () => {
    const { sb, calls } = fakeSb({
      sensitivity: 50,
      campaigns: [
        { id: "w1", name: "West", status: "active", daily_budget_cents: 10000, geo_targets: ["us-west"] },
        { id: "e1", name: "East", status: "active", daily_budget_cents: 5000, geo_targets: ["us-east"] },
      ],
    });
    const r = await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts, today: "2026-07-06" });
    expect(r.suggested).toBe(1);
    expect(calls.upserts).toHaveLength(1);
    const row = (calls.upserts[0] as Record<string, unknown>[])[0] ?? calls.upserts[0];
    expect(row).toMatchObject({ shop_id: SHOP, suggested_on: "2026-07-06", status: "pending" });
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
});
