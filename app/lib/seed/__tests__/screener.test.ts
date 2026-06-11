import { describe, it, expect } from "vitest";
import { buildScreenerRuns, SCREENER_SEED_SKU_TITLES, type SkuRef } from "../screener";
import { calibrate, compositeScore, gradeFor } from "../../screener/calibrate.server";
import { DIMENSIONS } from "../../screener/types";

const SHOP = "00000000-0000-0000-0000-000000000001";
const NOW = Date.UTC(2026, 5, 10, 18, 0, 0); // fixed → deterministic

function fullSkuMap(): Map<string, SkuRef> {
  const m = new Map<string, SkuRef>();
  m.set("Cascade Rain Shell — M", { id: "sku-cascade", priceCents: 15900 });
  m.set("Basecamp Water Bottle 750ml", { id: "sku-bottle", priceCents: 2400 });
  m.set("Summit Logo Tee — L", { id: "sku-tee", priceCents: 3200 });
  return m;
}

describe("buildScreenerRuns", () => {
  const runs = buildScreenerRuns({ shopId: SHOP, skuByTitle: fullSkuMap(), nowMs: NOW });

  it("produces four done runs for the shop", () => {
    expect(runs).toHaveLength(4);
    for (const r of runs) {
      expect(r.shop_id).toBe(SHOP);
      expect(r.status).toBe("done");
      expect(r.source).toBe("manual");
      expect(r.scorecard).not.toBeNull();
      expect(r.creative_input).not.toBeNull();
    }
  });

  it("orders newest-first so the winner renders on load", () => {
    const times = runs.map((r) => Date.parse(r.created_at));
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]).toBeGreaterThan(times[i]);
    }
    // The latest run is the winning Cascade creative.
    expect(runs[0].scorecard.grade).toBe("winning");
    expect(runs[0].creative_input.destinationUrl).toContain("cascade-rain-shell");
    // completed_at is always after created_at.
    for (const r of runs) {
      expect(Date.parse(r.completed_at)).toBeGreaterThan(Date.parse(r.created_at));
    }
  });

  it("spans the full grade range for a representative demo", () => {
    const grades = runs.map((r) => r.scorecard.grade);
    expect(grades).toContain("winning");
    expect(grades).toContain("okay");
    expect(grades).toContain("poor");
  });

  it("scorecards are internally consistent with production calibrate math", () => {
    for (const r of runs) {
      const card = r.scorecard;
      // All 13 canonical dimensions, in order, with valid scores.
      expect(card.metrics.map((m) => m.id)).toEqual(DIMENSIONS.map((d) => d.id));
      for (const m of card.metrics) {
        expect(m.score).toBeGreaterThanOrEqual(0);
        expect(m.score).toBeLessThanOrEqual(100);
        expect(m.reasoning.length).toBeGreaterThan(10);
        const dim = DIMENSIONS.find((d) => d.id === m.id)!;
        expect(m.group).toBe(dim.group);
        expect(m.label).toBe(dim.label);
      }
      // composite + grade derive from the metrics exactly as the real pipeline.
      expect(card.composite).toBe(compositeScore(card.metrics));
      expect(card.grade).toBe(gradeFor(card.composite));
      // outcomes match what calibrate() would produce for these metrics/spend.
      const inputs = {
        accountBaselineCtr: 0.018,
        accountBaselineCpmCents: 2600,
        accountEngagementRate: 0.05,
        breakEvenRoas: 1.51,
        skuCvr: 0.022,
        topAdNames: [
          "Brand Search — Exact — US",
          "Retargeting — 30d Site Engagers",
          "Prospecting — Advantage+ Shopping — US",
        ],
        historyAdCount: 22,
        mappedSku: card.outcomes.mappedSku,
        skuPriceCents: card.outcomes.skuPriceCents,
      };
      const recomputed = calibrate(card.metrics, inputs, r.assumed_spend_cents);
      expect(card.outcomes).toEqual(recomputed.outcomes);
      expect(card.confidence).toBe(recomputed.confidence);
    }
  });

  it("only surfaces winning variants (positive delta over original)", () => {
    for (const r of runs) {
      for (const v of r.variants) {
        expect(v.delta).toBeGreaterThan(0);
        expect(v.composite).toBe(r.scorecard.composite + v.delta);
        expect(v.input.headline.length).toBeGreaterThan(0);
        expect(v.rationale.length).toBeGreaterThan(10);
      }
    }
    // The hero (winning) run carries variants to demo the improvement flow.
    expect(runs[0].variants.length).toBeGreaterThanOrEqual(2);
  });

  it("maps mapped_sku_id and outcome price to the resolved SKU", () => {
    const cascade = runs[0];
    expect(cascade.mapped_sku_id).toBe("sku-cascade");
    expect(cascade.scorecard.outcomes.skuPriceCents).toBe(15900);
    expect(cascade.scorecard.confidence).toBe("high");
  });

  it("degrades gracefully when a SKU is unresolved", () => {
    const noSkus = buildScreenerRuns({ shopId: SHOP, skuByTitle: new Map(), nowMs: NOW });
    const cascade = noSkus[0];
    expect(cascade.mapped_sku_id).toBeNull();
    expect(cascade.scorecard.outcomes.mappedSku).toBeNull();
    expect(cascade.scorecard.outcomes.skuPriceCents).toBeNull();
    // Still a valid, complete scorecard.
    expect(cascade.scorecard.metrics).toHaveLength(13);
    expect(cascade.scorecard.confidence).toBe("medium"); // no SKU price → not high
  });

  it("exposes the SKU titles the runner resolves", () => {
    expect(SCREENER_SEED_SKU_TITLES).toContain("Cascade Rain Shell — M");
    expect(SCREENER_SEED_SKU_TITLES.length).toBeGreaterThan(0);
  });
});
