import { describe, it, expect } from "vitest";
import { sortSkusByUrgency } from "../client";
import type { SkuVM } from "~/components/dashboard/view-models";

const sku = (id: string, days_of_cover: number, revenue_30d_cents: number): SkuVM =>
  ({ id, days_of_cover, revenue_30d_cents } as SkuVM);

// P2-13: "Needs attention" must surface the real at-risk SKUs first — soonest to
// run out, and within a tie the higher-revenue best-seller above a $0 sample.
describe("sortSkusByUrgency", () => {
  it("puts the soonest-to-run-out SKU first", () => {
    const out = sortSkusByUrgency([
      sku("healthy", 40, 1000),
      sku("stockout", 0, 500),
      sku("risk", 7, 200),
    ]);
    expect(out.map((s) => s.id)).toEqual(["stockout", "risk", "healthy"]);
  });

  it("breaks days-of-cover ties by revenue so the best-seller beats a $0 sample", () => {
    const out = sortSkusByUrgency([
      sku("sample", 0, 0),
      sku("bestseller", 0, 90_000),
    ]);
    expect(out.map((s) => s.id)).toEqual(["bestseller", "sample"]);
  });
});
