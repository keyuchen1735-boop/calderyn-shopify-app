import { describe, it, expect } from "vitest";
import { favorability, type RegionForecast } from "../score";

const base: RegionForecast = { avgTempC: 18, precipMm: 0, snowCm: 0, avgDaylightH: 12 };

describe("favorability", () => {
  it("returns 0 for the neutral baseline", () => {
    expect(favorability(base)).toBeCloseTo(0, 6);
  });
  it("stays within [0,1]", () => {
    const extreme = favorability({ avgTempC: -30, precipMm: 100, snowCm: 50, avgDaylightH: 0 });
    expect(extreme).toBeGreaterThanOrEqual(0);
    expect(extreme).toBeLessThanOrEqual(1);
  });
  it("is monotonic: colder scores higher", () => {
    expect(favorability({ ...base, avgTempC: 5 })).toBeGreaterThan(favorability({ ...base, avgTempC: 15 }));
  });
  it("is monotonic: more precipitation scores higher", () => {
    expect(favorability({ ...base, precipMm: 20 })).toBeGreaterThan(favorability({ ...base, precipMm: 5 }));
  });
  it("is monotonic: more snow scores higher", () => {
    expect(favorability({ ...base, snowCm: 8 })).toBeGreaterThan(favorability({ ...base, snowCm: 2 }));
  });
  it("is monotonic: shorter daylight scores higher", () => {
    expect(favorability({ ...base, avgDaylightH: 8 })).toBeGreaterThan(favorability({ ...base, avgDaylightH: 11 }));
  });
  it("cold+rain beats warm+clear (the core hypothesis)", () => {
    const coldRain = favorability({ avgTempC: 2, precipMm: 25, snowCm: 3, avgDaylightH: 9 });
    const warmClear = favorability({ avgTempC: 28, precipMm: 0, snowCm: 0, avgDaylightH: 14 });
    expect(coldRain).toBeGreaterThan(warmClear);
  });
});
