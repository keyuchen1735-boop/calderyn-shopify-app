import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runWeatherSuggestForShop } from "../weather-suggest.server";
import type { RegionCode } from "../../ads/actions";
import type { RegionForecast } from "../../weather/score";
import type { writeWeatherAlert } from "../../weather/alert-writer.server";

const SHOP = "11111111-1111-1111-1111-111111111111";

function fakeSb(opts: {
  sensitivity: number;
  campaigns: Array<Record<string, unknown>>;
  demandRows?: Array<Record<string, unknown>>;
}) {
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
      if (table === "v_sku_regional_demand") {
        return Promise.resolve({ data: opts.demandRows ?? [], error: null }).then(res);
      }
      return Promise.resolve({ data: null, error: null }).then(res);
    };
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb };
}

// us-east is cold+wet (high favorability); us-west is warm+sunny (low favorability).
const forecasts = new Map<RegionCode, RegionForecast>([
  ["us-west", { avgTempC: 28, precipMm: 0, snowCm: 0, avgDaylightH: 14 }],
  ["us-east", { avgTempC: 2, precipMm: 40, snowCm: 8, avgDaylightH: 9 }],
]);
const fetchForecasts = vi.fn(async () => forecasts);

const demandRow = {
  sku_id: "sku1",
  main_demand_region: "us-east",
  demand_units_30d: 60,
  daily_demand: 2,
  demand_share: 1,
  stock_in_region: 3,
  dest_location_external_id: "gid://Location/1",
  dest_location_name: "NJ",
  src_location_external_id: "gid://Location/2",
  src_location_name: "CA",
  src_available: 50,
  inventory_item_id: "gid://InventoryItem/9",
  locations_detail: null,
};

describe("runWeatherSuggestForShop", () => {
  it("skips when sensitivity is 0 (no fetch, no write)", async () => {
    const { sb } = fakeSb({ sensitivity: 0, campaigns: [] });
    const ff = vi.fn(async () => forecasts);
    const writeAlert = vi.fn(async () => "alert-id");
    const r = await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts: ff, today: "2026-07-06", writeAlert });
    expect(r.suggested).toBe(0);
    expect(r.skippedReason).toBe("sensitivity_off");
    expect(ff).not.toHaveBeenCalled();
    expect(writeAlert).not.toHaveBeenCalled();
  });

  it("writes a budget alert for a two-region shop with a favorable score gap", async () => {
    const { sb } = fakeSb({
      sensitivity: 50,
      campaigns: [
        { id: "w1", name: "West", status: "active", daily_budget_cents: 10000, geo_targets: ["us-west"] },
        { id: "e1", name: "East", status: "active", daily_budget_cents: 5000, geo_targets: ["us-east"] },
      ],
      demandRows: [],
    });
    const writeAlert = vi.fn<typeof writeWeatherAlert>(async () => "alert-id");
    const r = await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts, today: "2026-07-06", writeAlert });
    expect(r.suggested).toBeGreaterThanOrEqual(1);
    expect(writeAlert).toHaveBeenCalled();
    const drafts = writeAlert.mock.calls.map((c) => c[3]);
    const budget = drafts.find((d) => d.entityRef.campaign_id != null);
    expect(budget).toBeDefined();
    expect(budget!.entityRef.campaign_id).toBe("w1");
  });

  it("writes an inventory alert for a single-campaign shop with an eligible demand row (regression guard)", async () => {
    const { sb } = fakeSb({
      sensitivity: 50,
      campaigns: [{ id: "n1", name: "National", status: "active", daily_budget_cents: 10000, geo_targets: [] }],
      demandRows: [demandRow],
    });
    const writeAlert = vi.fn<typeof writeWeatherAlert>(async () => "alert-id");
    const r = await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts, today: "2026-07-06", writeAlert });
    expect(r.suggested).toBeGreaterThanOrEqual(1);
    expect(writeAlert).toHaveBeenCalled();
    const drafts = writeAlert.mock.calls.map((c) => c[3]);
    const inventory = drafts.find((d) => d.entityRef.sku_id != null);
    expect(inventory).toBeDefined();
    expect(inventory!.entityRef.sku_id).toBe("sku1");
  });

  it("skips a single-campaign shop with no demand rows", async () => {
    const { sb } = fakeSb({
      sensitivity: 50,
      campaigns: [{ id: "n1", name: "National", status: "active", daily_budget_cents: 10000, geo_targets: [] }],
      demandRows: [],
    });
    const writeAlert = vi.fn(async () => "alert-id");
    const r = await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts, today: "2026-07-06", writeAlert });
    expect(r.suggested).toBe(0);
    expect(r.skippedReason).toBe("no_suggestion");
    expect(writeAlert).not.toHaveBeenCalled();
  });
});
