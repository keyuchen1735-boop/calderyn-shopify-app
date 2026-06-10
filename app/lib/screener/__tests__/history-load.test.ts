import { describe, it, expect, vi } from "vitest";
import {
  buildChain,
  setSupabaseResponses,
  getRecorded,
} from "../../__tests__/_supabase_chain_mock";
import { loadCalibrationInputs } from "../history.server";
import { calibrate } from "../calibrate.server";
import {
  DEFAULT_BASELINE_CTR,
  DEFAULT_BREAK_EVEN_ROAS,
  DEFAULT_ENGAGEMENT_RATE,
} from "../types";

// history.server only touches supabase.server lazily (getSupabase is called inside
// loadCalibrationInputs, not at import), so imports can stay first; Vitest hoists
// this vi.mock above them at transform time.
vi.mock("../../supabase.server", () => ({
  getSupabase: () => buildChain(),
  resolveShopId: vi.fn(async (domain: string) => `shop-id-for-${domain}`),
}));

// Fixed clock so the 30-day window is deterministic: since = 2026-05-10.
const NOW = new Date("2026-06-09T00:00:00.000Z");
const SHOP = "demo.myshopify.com";

describe("loadCalibrationInputs", () => {
  it("populates real account metrics from facts and reaches high confidence", async () => {
    const engRows = Array.from({ length: 16 }, (_, i) => ({
      day: "2026-06-01",
      impressions: 100,
      reactions: 5,
      comments: 0,
      shares: 0,
      saves: 0,
      ad_external_id: `ad_${i}`,
    }));
    setSupabaseResponses([
      // 1. ad_spend_fact (30d) → ctr 0.015, cpm 4000, cvr 0.1
      { data: [
        { impressions: 1000, clicks: 20, spend_cents: 5000, conversions: 2 },
        { impressions: 1000, clicks: 10, spend_cents: 3000, conversions: 1 },
      ], error: null },
      // 2. ad_engagement_fact (eng + distinct count) → rate 0.05, 16 ads
      { data: engRows, error: null },
      // 3. campaign_grade_fact → breakEven 1.9
      { data: [{ break_even_roas: 1.8 }, { break_even_roas: 2.0 }], error: null },
      // 4. ad_engagement_fact (topAdNames)
      { data: [{ ad_campaign_dim: { name: "Summer" } }, { ad_campaign_dim: { name: "Winter" } }], error: null },
      // 5. sku_dim → id
      { data: { id: "sku-uuid-1" }, error: null },
      // 6. order_line_fact → avg price 4500
      { data: [{ price_cents: 4000 }, { price_cents: 5000 }], error: null },
    ]);

    const inputs = await loadCalibrationInputs(SHOP, "HYD-SERUM-30ML", NOW);

    expect(inputs.accountBaselineCtr).toBeCloseTo(0.015, 6);
    expect(inputs.accountBaselineCpmCents).toBeCloseTo(4000, 6);
    expect(inputs.skuCvr).toBeCloseTo(0.1, 6);
    expect(inputs.accountEngagementRate).toBeCloseTo(0.05, 6);
    expect(inputs.skuPriceCents).toBe(4500);
    expect(inputs.historyAdCount).toBe(16);
    expect(inputs.breakEvenRoas).toBeCloseTo(1.9, 6);
    expect(inputs.topAdNames).toEqual(["Summer", "Winter"]);

    // The whole point of the increment: real data unlocks "high" confidence.
    expect(calibrate([], inputs, 10_000).confidence).toBe("high");

    // Wiring: the real fact tables are queried, windowed by day, and price comes
    // from order_line_fact (not the non-existent sku_dim.price_cents).
    const tables = getRecorded("from").flat();
    expect(tables).toContain("ad_spend_fact");
    expect(tables).toContain("ad_engagement_fact");
    expect(tables).toContain("campaign_grade_fact");
    expect(tables).toContain("sku_dim");
    expect(tables).toContain("order_line_fact");
    expect(getRecorded("gte")).toContainEqual(["day", "2026-05-10"]);
    expect(getRecorded("select").flat()).toContain("price_cents");
  });

  it("falls back to documented defaults for an empty account (low confidence)", async () => {
    setSupabaseResponses([
      { data: [], error: null }, // ad_spend_fact
      { data: [], error: null }, // ad_engagement_fact (eng + count)
      { data: [], error: null }, // campaign_grade_fact
      { data: [], error: null }, // ad_engagement_fact (topAdNames)
    ]);

    const inputs = await loadCalibrationInputs(SHOP, null, NOW);

    expect(inputs.accountBaselineCtr).toBe(DEFAULT_BASELINE_CTR);
    expect(inputs.accountEngagementRate).toBe(DEFAULT_ENGAGEMENT_RATE);
    expect(inputs.breakEvenRoas).toBe(DEFAULT_BREAK_EVEN_ROAS);
    expect(inputs.skuPriceCents).toBeNull();
    expect(inputs.skuCvr).toBeNull();
    expect(inputs.historyAdCount).toBe(0);
    expect(inputs.topAdNames).toEqual([]);
    expect(calibrate([], inputs, 10_000).confidence).toBe("low");
  });
});
