import { describe, expect, it } from "vitest";
import {
  detectCtrLow,
  detectRankingSlips,
  detectRisingQueries,
  parseStorefrontPath,
  RANK_SLIP_POSITIONS,
  RANK_SLIP_SUSTAIN_DAYS,
} from "../detect.server";
import type { RankingSeries } from "../types";

const PAGE = "https://peak.calderyncompany.com/storefront/products/trail-boots";

function series(
  points: Array<[string, number, number, number, number]>,
  pageUrl = PAGE,
  query = "trail boots",
): RankingSeries {
  return {
    pageUrl,
    query,
    days: points.map(([day, position, impressions, clicks, ctr]) => ({ day, position, impressions, clicks, ctr })),
  };
}

describe("parseStorefrontPath", () => {
  it("classifies home, product, collection and other paths", () => {
    expect(parseStorefrontPath("https://x/storefront")).toEqual({ entityType: "home", handle: null });
    expect(parseStorefrontPath(PAGE)).toEqual({ entityType: "product", handle: "trail-boots" });
    expect(parseStorefrontPath("/storefront/collections/hiking")).toEqual({ entityType: "collection", handle: "hiking" });
    expect(parseStorefrontPath("/storefront/cart")).toEqual({ entityType: "other", handle: null });
  });
});

describe("detectRankingSlips", () => {
  it("drafts a publishable product move when the position slips 3+ for 3 sustained days", () => {
    const s = series([
      ["2026-07-06", 4, 100, 9, 0.09], ["2026-07-07", 4, 100, 9, 0.09],
      ["2026-07-08", 4, 100, 9, 0.09], ["2026-07-09", 5, 100, 8, 0.08],
      ["2026-07-16", 8, 90, 2, 0.02], ["2026-07-17", 9, 90, 2, 0.02], ["2026-07-18", 9, 90, 1, 0.01],
    ]);
    const out = detectRankingSlips([s]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("seo_regression_patch");
    expect(out[0].dedupKey).toBe(`rank-slip:${PAGE}:trail boots`);
    expect(out[0].payload).toMatchObject({
      applyMode: "publish_meta", entityType: "product", handle: "trail-boots", focusQuery: "trail boots",
    });
    expect(out[0].headline).not.toMatch(/ploy/i);
  });
  it("needs the slip sustained, not a single bad day", () => {
    const s = series([
      ["2026-07-14", 4, 100, 9, 0.09], ["2026-07-15", 4, 100, 9, 0.09],
      ["2026-07-16", 4, 100, 9, 0.09], ["2026-07-17", 4, 100, 9, 0.09],
      ["2026-07-18", 9, 90, 1, 0.01],
    ]);
    expect(detectRankingSlips([s])).toHaveLength(0);
  });
  it("drafts a review move (not a publish) for a non-product page", () => {
    const s = series(
      [
        ["2026-07-14", 3, 100, 9, 0.09], ["2026-07-15", 3, 100, 9, 0.09],
        ["2026-07-16", 7, 90, 2, 0.02], ["2026-07-17", 7, 90, 2, 0.02], ["2026-07-18", 8, 90, 1, 0.01],
      ],
      "https://x/storefront", "hiking gear store",
    );
    const out = detectRankingSlips([s]);
    expect(out).toHaveLength(1);
    expect(out[0].payload.applyMode).toBe("review");
  });
  it("threshold constants hold the spec values", () => {
    expect(RANK_SLIP_POSITIONS).toBe(3);
    expect(RANK_SLIP_SUSTAIN_DAYS).toBe(3);
  });
});

describe("detectCtrLow", () => {
  it("flags a top-10 page whose CTR is under half the expected rate", () => {
    // pos 5 expects 7% (EXPECTED_CTR_BY_POSITION[4]); 300 impressions at 2% is under 3.5%.
    const s = series([
      ["2026-07-16", 5, 100, 2, 0.02], ["2026-07-17", 5, 100, 2, 0.02], ["2026-07-18", 5, 100, 2, 0.02],
    ]);
    const out = detectCtrLow([s]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("seo_meta_rewrite");
    expect(out[0].dedupKey).toBe(`ctr-low:${PAGE}:trail boots`);
  });
  it("skips thin impressions and pages outside the top 10", () => {
    const thin = series([["2026-07-18", 5, 40, 0, 0]]);
    const deep = series([["2026-07-16", 14, 200, 1, 0.005], ["2026-07-17", 14, 200, 1, 0.005]]);
    expect(detectCtrLow([thin, deep])).toHaveLength(0);
  });
});

describe("detectRisingQueries", () => {
  it("flags a rising query sitting at position 8-20", () => {
    const s = series([
      ["2026-07-08", 12, 10, 0, 0], ["2026-07-09", 12, 10, 0, 0], ["2026-07-10", 12, 10, 0, 0],
      ["2026-07-14", 12, 20, 1, 0.05], ["2026-07-15", 12, 20, 1, 0.05], ["2026-07-16", 12, 20, 1, 0.05],
      ["2026-07-17", 11, 20, 1, 0.05], ["2026-07-18", 11, 20, 1, 0.05],
    ]);
    const out = detectRisingQueries([s]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("seo_content_boost");
    expect(out[0].dedupKey).toBe("rising:trail boots");
    expect(out[0].payload.applyMode).toBe("publish_meta");
  });
  it("skips queries already ranking well or not growing", () => {
    const good = series([
      ["2026-07-11", 4, 20, 2, 0.1], ["2026-07-14", 4, 40, 4, 0.1],
      ["2026-07-15", 4, 40, 4, 0.1], ["2026-07-16", 4, 40, 4, 0.1],
    ]);
    // Flat needs a full prior week on record, or the growth check has nothing
    // to compare against (a query with no prior data but healthy volume is
    // legitimately "rising").
    const flat = series(
      Array.from({ length: 14 }, (_, i): [string, number, number, number, number] =>
        [`2026-07-${String(5 + i).padStart(2, "0")}`, 12, 40, 1, 0.02]),
    );
    expect(detectRisingQueries([good, flat])).toHaveLength(0);
  });
});
