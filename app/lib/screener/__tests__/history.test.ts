import { describe, it, expect } from "vitest";
import {
  aggregateEngagement,
  aggregateSpend,
  avgPriceCents,
  shapeCalibrationInputs,
} from "../history.server";

describe("avgPriceCents", () => {
  it("averages positive unit prices and rounds to whole cents", () => {
    expect(avgPriceCents([{ price_cents: 1000 }, { price_cents: 1001 }, { price_cents: 1001 }])).toBe(1001);
  });

  it("ignores zero, negative, and missing prices", () => {
    expect(avgPriceCents([{ price_cents: 3000 }, { price_cents: 0 }, { price_cents: -5 }, { price_cents: null }])).toBe(3000);
  });

  it("returns null when there are no positive prices", () => {
    expect(avgPriceCents([])).toBeNull();
    expect(avgPriceCents([{ price_cents: 0 }])).toBeNull();
  });
});

describe("aggregateEngagement", () => {
  const since = "2026-05-10";

  it("rates engagement over in-window rows but counts distinct ads over all rows", () => {
    const out = aggregateEngagement(
      [
        { day: "2026-06-01", impressions: 1000, reactions: 10, comments: 5, shares: 3, saves: 2, ad_external_id: "ad_A" },
        { day: "2026-05-20", impressions: 1000, reactions: 5, comments: 0, shares: 0, saves: 0, ad_external_id: "ad_B" },
        { day: "2026-04-01", impressions: 1000, reactions: 100, comments: 0, shares: 0, saves: 0, ad_external_id: "ad_C" },
        { day: "2026-06-02", impressions: 500, reactions: 1, comments: 0, shares: 0, saves: 0, ad_external_id: "ad_A" },
      ],
      since,
    );
    // in-window engagement = (20 + 5 + 1) / (1000 + 1000 + 500)
    expect(out.engagementRate).toBeCloseTo(26 / 2500, 6);
    // distinct over ALL rows incl. the out-of-window one
    expect(out.historyAdCount).toBe(3);
  });

  it("returns null engagementRate when no in-window impressions, still counts ads", () => {
    const out = aggregateEngagement(
      [{ day: "2026-01-01", impressions: 1000, reactions: 5, comments: 0, shares: 0, saves: 0, ad_external_id: "ad_Z" }],
      since,
    );
    expect(out.engagementRate).toBeNull();
    expect(out.historyAdCount).toBe(1);
  });

  it("returns null rate and zero ad count for an empty result set", () => {
    expect(aggregateEngagement([], since)).toEqual({ engagementRate: null, historyAdCount: 0 });
  });
});

describe("aggregateSpend", () => {
  it("computes CTR, CPM, and CVR from summed spend rows", () => {
    const out = aggregateSpend([
      { impressions: 1000, clicks: 20, spend_cents: 5000, conversions: 2 },
      { impressions: 1000, clicks: 10, spend_cents: 3000, conversions: 1 },
    ]);
    expect(out.ctr).toBeCloseTo(0.015, 6); // 30 / 2000
    expect(out.cpmCents).toBeCloseTo(4000, 6); // 8000 / 2000 * 1000
    expect(out.cvr).toBeCloseTo(0.1, 6); // 3 / 30
  });

  it("returns null CTR/CPM when there are no impressions", () => {
    const out = aggregateSpend([
      { impressions: 0, clicks: 0, spend_cents: 0, conversions: 0 },
    ]);
    expect(out.ctr).toBeNull();
    expect(out.cpmCents).toBeNull();
    expect(out.cvr).toBeNull();
  });

  it("returns null CVR when there are impressions but no clicks (CTR stays a real 0)", () => {
    const out = aggregateSpend([
      { impressions: 500, clicks: 0, spend_cents: 1000, conversions: 0 },
    ]);
    expect(out.ctr).toBe(0);
    expect(out.cpmCents).toBeCloseTo(2000, 6); // 1000 / 500 * 1000
    expect(out.cvr).toBeNull();
  });

  it("returns all null for an empty result set", () => {
    const out = aggregateSpend([]);
    expect(out).toEqual({ ctr: null, cpmCents: null, cvr: null });
  });
});

describe("shapeCalibrationInputs", () => {
  it("uses real values when present", () => {
    const out = shapeCalibrationInputs({
      ctr: 0.013,
      cpmCents: 1800,
      engagementRate: 0.06,
      breakEvenRoas: 1.9,
      mappedSku: "HYD-SERUM-30ML",
      skuPriceCents: 4200,
      skuCvr: 0.021,
      topAdNames: ["A", "B", "C"],
      historyAdCount: 23,
    });
    expect(out.accountBaselineCtr).toBe(0.013);
    expect(out.skuPriceCents).toBe(4200);
    expect(out.historyAdCount).toBe(23);
  });

  it("falls back to documented defaults for missing account metrics, leaving SKU fields null", () => {
    const out = shapeCalibrationInputs({
      ctr: null, cpmCents: null, engagementRate: null, breakEvenRoas: null,
      mappedSku: null, skuPriceCents: null, skuCvr: null, topAdNames: [], historyAdCount: 0,
    });
    expect(out.accountBaselineCtr).toBeGreaterThan(0);
    expect(out.breakEvenRoas).toBeGreaterThan(0);
    expect(out.skuPriceCents).toBeNull();
    expect(out.skuCvr).toBeNull();
  });
});
