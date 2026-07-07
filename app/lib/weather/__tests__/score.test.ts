import { describe, it, expect } from "vitest";
import { favorability, demandConfidence, niceness, SUPPRESSION, BOOST, type RegionForecast } from "../score";

const ideal: RegionForecast = { avgTempC: 26, precipMm: 0, snowCm: 0, avgDaylightH: 14 };
const neutral: RegionForecast = { avgTempC: 12, precipMm: 15, snowCm: 0, avgDaylightH: 11 };
const miserable: RegionForecast = { avgTempC: 0, precipMm: 30, snowCm: 10, avgDaylightH: 8 };

describe("weather score — asymmetric online-demand model (Steinker et al. 2017)", () => {
  it("neutral weather is the 0.5 midpoint with ~no signal", () => {
    expect(favorability(neutral)).toBeCloseTo(0.5, 5);
    expect(niceness(neutral)).toBeCloseTo(0, 5);
    expect(demandConfidence(neutral)).toBeCloseTo(0, 5);
  });

  it("nicer weather predicts LESS online demand (monotone direction)", () => {
    // good weather pulls shoppers off their screens → lower favorability.
    expect(favorability(ideal)).toBeLessThan(favorability(neutral));
    expect(favorability(neutral)).toBeLessThan(favorability(miserable));
  });

  it("the effect is ASYMMETRIC: good-weather suppression >> bad-weather boost", () => {
    const suppression = favorability(neutral) - favorability(ideal); // large
    const boost = favorability(miserable) - favorability(neutral); // small
    expect(suppression).toBeGreaterThan(boost);
    expect(SUPPRESSION).toBeGreaterThan(BOOST);
    // concretely, suppression is well over double the boost.
    expect(suppression).toBeGreaterThan(boost * 2);
  });

  it("stays in [0,1] at the extremes and matches the computed anchors", () => {
    expect(favorability(ideal)).toBeCloseTo(0.05, 4);
    expect(favorability(miserable)).toBeCloseTo(0.6931, 3);
    const extreme = favorability({ avgTempC: -30, precipMm: 100, snowCm: 50, avgDaylightH: 0 });
    expect(extreme).toBeGreaterThanOrEqual(0);
    expect(extreme).toBeLessThanOrEqual(1);
  });

  it("confidence is highest for clearly nice weather, partial for bad, ~zero for mild", () => {
    // the good-weather suppression is the reliable half of the asymmetry.
    expect(demandConfidence(ideal)).toBeGreaterThan(demandConfidence(miserable));
    expect(demandConfidence(miserable)).toBeGreaterThan(demandConfidence(neutral));
    expect(demandConfidence(ideal)).toBeCloseTo(0.9, 4);
    expect(demandConfidence(miserable)).toBeCloseTo(0.4827, 3);
    expect(demandConfidence(ideal)).toBeLessThanOrEqual(1);
  });

  it("niceness rises with warmth, dryness and daylight, and falls with snow", () => {
    const base: RegionForecast = { avgTempC: 12, precipMm: 15, snowCm: 0, avgDaylightH: 11 };
    expect(niceness({ ...base, avgTempC: 25 })).toBeGreaterThan(niceness(base));
    expect(niceness({ ...base, precipMm: 0 })).toBeGreaterThan(niceness(base));
    expect(niceness({ ...base, avgDaylightH: 14 })).toBeGreaterThan(niceness(base));
    expect(niceness({ ...base, snowCm: 8 })).toBeLessThan(niceness(base));
  });

  it("preserves the ranking the reallocation relies on: bad-weather region outscores good-weather region", () => {
    const coldRain = favorability({ avgTempC: 2, precipMm: 25, snowCm: 3, avgDaylightH: 9 });
    const warmClear = favorability({ avgTempC: 28, precipMm: 0, snowCm: 0, avgDaylightH: 14 });
    expect(coldRain).toBeGreaterThan(warmClear);
  });
});
