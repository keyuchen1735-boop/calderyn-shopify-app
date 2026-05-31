import { describe, it, expect } from "vitest";
import {
  scoreReorderTiming,
  DEFAULT_REORDER_THRESHOLD,
  type SkuFlat,
} from "../detectors/reorder-timing.server";

const NOW = new Date("2026-05-31T00:00:00Z");

function sku(over: Partial<SkuFlat>): SkuFlat {
  return { id: "s1", sku: "SKU1", title: "Thing", on_hand: 10, velocity: 1, days_of_cover: 10, ...over };
}

describe("scoreReorderTiming", () => {
  it("returns nothing when no sku breaches", () => {
    expect(scoreReorderTiming([sku({ days_of_cover: 30 })], {}, DEFAULT_REORDER_THRESHOLD, NOW)).toEqual([]);
  });

  it("excludes slow movers below min_velocity", () => {
    const out = scoreReorderTiming([sku({ days_of_cover: 2, velocity: 0.05 })], {}, DEFAULT_REORDER_THRESHOLD, NOW);
    expect(out).toEqual([]);
  });

  it("flags a critical low-stock sku", () => {
    const out = scoreReorderTiming(
      [sku({ id: "s1", days_of_cover: 2, velocity: 2 })],
      { s1: 1000 },
      DEFAULT_REORDER_THRESHOLD,
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("critical");
    expect(out[0].claude_rank).toBe(1);
    expect(out[0].entity_ref).toEqual({ sku: "SKU1", sku_id: "s1", title: "Thing" });
    // unmet = (14 - 2) * 2 = 24 units; impact = 24 * $10 = $240
    expect(out[0].dollar_impact).toBeCloseTo(240);
    expect(out[0].evidence.days_of_cover).toBe(2);
  });

  it("ranks by dollar impact descending", () => {
    const out = scoreReorderTiming(
      [
        sku({ id: "low", days_of_cover: 5, velocity: 1 }),
        sku({ id: "high", days_of_cover: 5, velocity: 5 }),
      ],
      { low: 500, high: 500 },
      DEFAULT_REORDER_THRESHOLD,
    );
    expect(out.map((d) => d.sku_id)).toEqual(["high", "low"]);
    expect(out[0].claude_rank).toBe(1);
    expect(out[1].claude_rank).toBe(2);
  });

  it("assigns severity by days_of_cover bands", () => {
    const [crit] = scoreReorderTiming([sku({ days_of_cover: 2, velocity: 1 })], {}, DEFAULT_REORDER_THRESHOLD, NOW);
    const [high] = scoreReorderTiming([sku({ days_of_cover: 5, velocity: 1 })], {}, DEFAULT_REORDER_THRESHOLD, NOW);
    const [med] = scoreReorderTiming([sku({ days_of_cover: 10, velocity: 1 })], {}, DEFAULT_REORDER_THRESHOLD, NOW);
    expect([crit.severity, high.severity, med.severity]).toEqual(["critical", "high", "medium"]);
  });
});
