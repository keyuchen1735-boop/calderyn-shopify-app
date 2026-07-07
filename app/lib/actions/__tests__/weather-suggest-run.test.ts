import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runWeatherSuggestForShop } from "../weather-suggest.server";
import type { RegionCode } from "../../ads/actions";
import type { RegionForecast } from "../../weather/score";

const SHOP = "11111111-1111-1111-1111-111111111111";

function fakeSb(opts: {
  sensitivity: number;
  campaigns: Array<Record<string, unknown>>;
  merchant?: { lat: number; lon: number };
}) {
  const calls = {
    upserts: [] as Array<{ table: string; rows: unknown; options: unknown }>,
    inserts: [] as Array<{ table: string; row: unknown }>,
  };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.in = vi.fn(() => chain);
    chain.not = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () =>
      table === "guardrail_config"
        ? {
            data: {
              weather_sensitivity: opts.sensitivity,
              merchant_lat: opts.merchant?.lat ?? null,
              merchant_lon: opts.merchant?.lon ?? null,
            },
            error: null,
          }
        : { data: null, error: null },
    );
    chain.then = (res: (v: { data: unknown; error: null }) => void) => {
      if (table === "ad_campaign_dim") return Promise.resolve({ data: opts.campaigns, error: null }).then(res);
      return Promise.resolve({ data: null, error: null }).then(res);
    };
    chain.insert = vi.fn((row: unknown) => {
      calls.inserts.push({ table, row });
      return Promise.resolve({ data: null, error: null });
    });
    chain.upsert = vi.fn((rows: unknown, options: unknown) => {
      calls.upserts.push({ table, rows, options });
      return { select: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: { id: "s1" }, error: null })) })) };
    });
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

const firstRow = (u: { rows: unknown }): Record<string, unknown> =>
  ((u.rows as Record<string, unknown>[])[0] ?? u.rows) as Record<string, unknown>;

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
    const wx = calls.upserts.filter((u) => u.table === "weather_suggestion");
    expect(wx).toHaveLength(1);
    expect(firstRow(wx[0])).toMatchObject({
      shop_id: SHOP,
      suggested_on: "2026-07-06",
      status: "pending",
      expires_on: "2026-07-09", // suggested_on + 3-day forecast horizon
    });
    // Insert-only: a same-day re-run must never overwrite a dismissed/armed
    // row's status (the resurrection bug).
    expect(wx[0].options).toMatchObject({ ignoreDuplicates: true });
  });
  it("auto-arms the suggestion when the sensitivity dial is at 100 (all-auto)", async () => {
    const { sb, calls } = fakeSb({
      sensitivity: 100,
      campaigns: [
        { id: "w1", name: "West", status: "active", daily_budget_cents: 10000, geo_targets: ["us-west"] },
        { id: "e1", name: "East", status: "active", daily_budget_cents: 5000, geo_targets: ["us-east"] },
      ],
    });
    await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts, today: "2026-07-06" });
    const wx = calls.upserts.filter((u) => u.table === "weather_suggestion");
    expect(firstRow(wx[0])).toMatchObject({ status: "armed" });
  });

  it("surfaces the prediction as an alert in the same run", async () => {
    const { sb, calls } = fakeSb({
      sensitivity: 50,
      campaigns: [
        { id: "w1", name: "West", status: "active", daily_budget_cents: 10000, geo_targets: ["us-west"] },
        { id: "e1", name: "East", status: "active", daily_budget_cents: 5000, geo_targets: ["us-east"] },
      ],
    });
    await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts, today: "2026-07-06" });
    // No active alert exists in the fake → the mirror inserts a fresh one.
    // (Plain insert, not upsert: the alerts dedup index is partial and can't
    // be targeted by ON CONFLICT.)
    const alerts = calls.inserts.filter((u) => u.table === "alerts");
    expect(alerts).toHaveLength(1);
    const row = alerts[0].row as Record<string, unknown>;
    expect(row).toMatchObject({
      shop_id: SHOP,
      detector_id: "weather_reallocation",
      severity: "low",
      status: "open",
    });
    expect(String(row.narrative)).toContain("weather");
  });

  it("queries the merchant's exact point for their home region when location is set", async () => {
    const { sb } = fakeSb({
      sensitivity: 50,
      merchant: { lat: 47.61, lon: -122.33 }, // Seattle → us-west
      campaigns: [
        { id: "w1", name: "West", status: "active", daily_budget_cents: 10000, geo_targets: ["us-west"] },
        { id: "e1", name: "East", status: "active", daily_budget_cents: 5000, geo_targets: ["us-east"] },
      ],
    });
    const ff = vi.fn(async (_points: readonly { region: string; lat: number; lon: number }[]) => forecasts);
    await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts: ff, today: "2026-07-06" });
    const points = ff.mock.calls[0][0];
    expect(points.find((p) => p.region === "us-west")).toMatchObject({ lat: 47.61, lon: -122.33 });
    expect(points).toHaveLength(4);
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
