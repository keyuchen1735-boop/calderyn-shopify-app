// app/lib/campaign-score/__tests__/blend.test.ts
import { describe, it, expect } from "vitest";
import { blendScore } from "../blend.server";

const cov = (covered: number, total: number) => ({ covered, total });

describe("blendScore", () => {
  it("weights 0.7 performance / 0.3 creative when both present", () => {
    const s = blendScore({ performance: 80, creative: 40, coverage: cov(2, 2), perfIsNodata: false });
    expect(s.value).toBe(68); // round(0.7*80 + 0.3*40) = 68
    expect(s.band).toBe("fair");
    expect(s.performance).toBe(80);
    expect(s.creative).toBe(40);
    expect(s.confidence).toBe("high");
  });

  it("scores on performance alone when creative is null (a missing half ⇒ low confidence)", () => {
    const s = blendScore({ performance: 82, creative: null, coverage: cov(0, 0), perfIsNodata: false });
    expect(s.value).toBe(82);
    expect(s.band).toBe("strong");
    expect(s.confidence).toBe("low");
  });

  it("scores on creative alone when performance is null", () => {
    const s = blendScore({ performance: null, creative: 40, coverage: cov(2, 2), perfIsNodata: false });
    expect(s.value).toBe(40);
    expect(s.band).toBe("weak");
    expect(s.confidence).toBe("medium");
  });

  it("is nodata with a null value when both halves are null", () => {
    const s = blendScore({ performance: null, creative: null, coverage: cov(0, 0), perfIsNodata: true });
    expect(s.value).toBeNull();
    expect(s.band).toBe("nodata");
    expect(s.confidence).toBe("low");
  });

  it("applies band thresholds at 75 (strong) and 55 (fair)", () => {
    const band = (v: number) =>
      blendScore({ performance: null, creative: v, coverage: cov(1, 1), perfIsNodata: false }).band;
    expect(band(75)).toBe("strong");
    expect(band(74)).toBe("fair");
    expect(band(55)).toBe("fair");
    expect(band(54)).toBe("weak");
  });

  it("passes coverage through to adsCovered/adsTotal and leaves weakDimensions/tips empty", () => {
    const s = blendScore({ performance: 80, creative: 60, coverage: cov(2, 3), perfIsNodata: false });
    expect(s.adsCovered).toBe(2);
    expect(s.adsTotal).toBe(3);
    expect(s.weakDimensions).toEqual([]);
    expect(s.tips).toEqual([]);
  });
});
