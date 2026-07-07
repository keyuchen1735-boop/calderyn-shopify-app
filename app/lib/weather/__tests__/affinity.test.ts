import { describe, it, expect } from "vitest";
import { weatherCondition, productAffinity, boostByWeather } from "../affinity";
import type { RegionForecast } from "../score";

const nice: RegionForecast = { avgTempC: 26, precipMm: 0, snowCm: 0, avgDaylightH: 14 };
const bad: RegionForecast = { avgTempC: 0, precipMm: 30, snowCm: 10, avgDaylightH: 8 };
const mild: RegionForecast = { avgTempC: 12, precipMm: 15, snowCm: 0, avgDaylightH: 11 };

describe("weatherCondition", () => {
  it("nice weather favors sun, bad weather favors storm, mild is neutral", () => {
    expect(weatherCondition(nice)).toBe("sun");
    expect(weatherCondition(bad)).toBe("storm");
    expect(weatherCondition(mild)).toBe("neutral");
  });
});

describe("productAffinity", () => {
  it("classifies by category and tags", () => {
    expect(productAffinity("Swimwear", [])).toBe("sun");
    expect(productAffinity("Rain Jacket", [])).toBe("storm");
    expect(productAffinity(null, ["umbrella", "waterproof"])).toBe("storm");
    expect(productAffinity("Sandals", ["summer", "beach"])).toBe("sun");
    expect(productAffinity("Coffee Mug", [])).toBe("neutral");
    expect(productAffinity(null, null)).toBe("neutral");
  });
  it("is neutral on a tie", () => {
    // one sun cue (beach) and one storm cue (rain) → tie → neutral.
    expect(productAffinity("Beach Rain Gear", [])).toBe("neutral");
  });
});

describe("boostByWeather", () => {
  const products = [
    { id: "a", category: "Mugs", tags: [] as string[] },
    { id: "b", category: "Swimwear", tags: [] as string[] },
    { id: "c", category: "Umbrellas", tags: [] as string[] },
    { id: "d", category: "Sandals", tags: ["summer"] },
  ];

  it("floats storm products first when it is stormy, preserving order within groups", () => {
    const out = boostByWeather(products, "storm");
    expect(out.map((p) => p.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("floats sun products first when it is sunny, preserving order within groups", () => {
    const out = boostByWeather(products, "sun");
    expect(out.map((p) => p.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("leaves the list unchanged when the condition is neutral", () => {
    const out = boostByWeather(products, "neutral");
    expect(out.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("returns a new array (does not mutate the input)", () => {
    const input = [...products];
    boostByWeather(input, "sun");
    expect(input.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });
});
