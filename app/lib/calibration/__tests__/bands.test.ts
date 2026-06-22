import { describe, it, expect } from "vitest";
import { calibrationBand, CALIBRATION_BANDS } from "../bands";

describe("CALIBRATION_BANDS", () => {
  it("has four ascending levels ending at 100", () => {
    expect(CALIBRATION_BANDS).toHaveLength(4);
    const ats = CALIBRATION_BANDS.map((b) => b.at);
    expect(ats).toEqual([0, 34, 67, 100]);
    // strictly ascending
    for (let i = 1; i < ats.length; i++) expect(ats[i]).toBeGreaterThan(ats[i - 1]);
  });

  it("has no em dashes in any band copy (founder treats them as an AI tell)", () => {
    for (const b of CALIBRATION_BANDS) {
      expect(b.copy).not.toMatch(/[—–]/);
      expect(b.name).not.toMatch(/[—–]/);
    }
  });
});

describe("calibrationBand", () => {
  it("treats null/undefined/NaN as a fresh shop at level 1", () => {
    for (const v of [null, undefined, NaN]) {
      const b = calibrationBand(v as number | null);
      expect(b.level).toBe(1);
      expect(b.name).toBe("Getting started");
      expect(b.trackWidthPct).toBe(0);
      expect(b.milestones.map((m) => m.reached)).toEqual([true, false, false, false]);
    }
  });

  it("places the real ~24% baseline in level 1 (Getting started)", () => {
    const b = calibrationBand(24);
    expect(b.level).toBe(1);
    expect(b.name).toBe("Getting started");
    expect(b.trackWidthPct).toBe(24);
    expect(b.milestones.map((m) => m.reached)).toEqual([true, false, false, false]);
  });

  it("crosses to level 2 (Learning) exactly at 34", () => {
    expect(calibrationBand(33).level).toBe(1);
    const b = calibrationBand(34);
    expect(b.level).toBe(2);
    expect(b.name).toBe("Learning");
    expect(b.milestones.map((m) => m.reached)).toEqual([true, true, false, false]);
  });

  it("crosses to level 3 (Trusted) exactly at 67", () => {
    expect(calibrationBand(66).level).toBe(2);
    const b = calibrationBand(67);
    expect(b.level).toBe(3);
    expect(b.name).toBe("Trusted");
    expect(b.milestones.map((m) => m.reached)).toEqual([true, true, true, false]);
  });

  it("reaches level 4 (Hands-off) only at a perfect 100", () => {
    expect(calibrationBand(99).level).toBe(3);
    const b = calibrationBand(100);
    expect(b.level).toBe(4);
    expect(b.name).toBe("Hands-off");
    expect(b.levels).toBe(4);
    expect(b.milestones.every((m) => m.reached)).toBe(true);
    expect(b.trackWidthPct).toBe(100);
  });

  it("clamps out-of-range input and rounds", () => {
    expect(calibrationBand(-5).trackWidthPct).toBe(0);
    expect(calibrationBand(150).trackWidthPct).toBe(100);
    expect(calibrationBand(150).level).toBe(4);
    expect(calibrationBand(23.6).trackWidthPct).toBe(24);
  });

  it("returns copy for the current band", () => {
    expect(calibrationBand(10).copy).toMatch(/learning how you run your shop/i);
    expect(calibrationBand(100).copy).toMatch(/the way you taught it/i);
  });
});
