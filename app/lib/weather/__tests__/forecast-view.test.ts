import { describe, it, expect } from "vitest";
import { buildForecastView, conditionFor } from "../forecast-view";
import type { RegionCode } from "../../ads/actions";
import type { RegionForecast } from "../score";

const forecasts = new Map<RegionCode, RegionForecast>([
  ["us-west", { avgTempC: 28, precipMm: 0, snowCm: 0, avgDaylightH: 14 }],
  ["us-central", { avgTempC: 20, precipMm: 8, snowCm: 0, avgDaylightH: 12 }],
  ["us-south", { avgTempC: 31, precipMm: 12, snowCm: 0, avgDaylightH: 13 }],
  ["us-east", { avgTempC: 2, precipMm: 25, snowCm: 3, avgDaylightH: 9 }],
]);

describe("buildForecastView", () => {
  it("returns one entry per region with its forecast and favorability score", () => {
    const view = buildForecastView(forecasts, null);
    expect(view.regions).toHaveLength(4);
    const east = view.regions.find((r) => r.region === "us-east")!;
    expect(east.avgTempC).toBe(2);
    expect(east.precipMm).toBe(25);
    expect(east.score).toBeGreaterThan(0.5);
    const west = view.regions.find((r) => r.region === "us-west")!;
    expect(west.score).toBeLessThan(east.score);
    expect(view.homeRegion).toBeNull();
  });

  it("marks the merchant's home region when a location is set", () => {
    const view = buildForecastView(forecasts, { lat: 47.61, lon: -122.33 }); // Seattle
    expect(view.homeRegion).toBe("us-west");
  });

  it("omits regions with no forecast data rather than fabricating zeros", () => {
    const partial = new Map<RegionCode, RegionForecast>([
      ["us-west", { avgTempC: 28, precipMm: 0, snowCm: 0, avgDaylightH: 14 }],
    ]);
    const view = buildForecastView(partial, null);
    expect(view.regions).toHaveLength(1);
    expect(view.regions[0].region).toBe("us-west");
  });
});

describe("conditionFor", () => {
  it("maps 3-day aggregates to a coarse sky condition", () => {
    expect(conditionFor({ precipMm: 0, snowCm: 0 })).toBe("clear");
    expect(conditionFor({ precipMm: 4, snowCm: 0 })).toBe("showers");
    expect(conditionFor({ precipMm: 22, snowCm: 0 })).toBe("rain");
    expect(conditionFor({ precipMm: 22, snowCm: 3 })).toBe("snow");
  });
});
