import { describe, it, expect } from "vitest";
import { shapeCalibrationInputs } from "../history.server";

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
