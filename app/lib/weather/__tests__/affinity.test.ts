import { describe, it, expect } from "vitest";
import { weatherCondition, productAffinity, boostByWeather } from "../affinity";
import type { RegionForecast } from "../score";

const nice: RegionForecast = { avgTempC: 26, precipMm: 0, snowCm: 0, avgDaylightH: 14 };
const bad: RegionForecast = { avgTempC: 0, precipMm: 30, snowCm: 10, avgDaylightH: 8 };
const mild: RegionForecast = { avgTempC: 12, precipMm: 15, snowCm: 0, avgDaylightH: 11 };

describe("weatherCondition", () => {
  it("classifies warm, dry, bright, snow-free weather as sun", () => {
    expect(weatherCondition(nice)).toBe("sun");
  });

  it("classifies cold, wet, dark, snowy weather as storm", () => {
    expect(weatherCondition(bad)).toBe("storm");
  });

  it("classifies mild weather as neutral", () => {
    expect(weatherCondition(mild)).toBe("neutral");
  });
});

describe("productAffinity", () => {
  it("classifies a Swimwear category as sun", () => {
    expect(productAffinity("Swimwear", [])).toBe("sun");
  });

  it("classifies a 'Rain Jacket' title-derived category as storm", () => {
    expect(productAffinity("Rain Jacket", [])).toBe("storm");
  });

  it("classifies umbrella/waterproof tags as storm", () => {
    expect(productAffinity(null, ["umbrella", "waterproof"])).toBe("storm");
  });

  it("classifies an unrelated product as neutral", () => {
    expect(productAffinity("Coffee Mug", [])).toBe("neutral");
  });

  it("classifies null category and tags as neutral", () => {
    expect(productAffinity(null, null)).toBe("neutral");
  });

  it("classifies a tie between sun and storm cues as neutral", () => {
    expect(productAffinity(null, ["sun", "rain"])).toBe("neutral");
  });
});

describe("boostByWeather", () => {
  const products = [
    { id: "a", category: "Mugs", tags: [] as string[] },
    { id: "b", category: "Swimwear", tags: [] as string[] },
    { id: "c", category: "Umbrellas", tags: [] as string[] },
    { id: "d", category: "Sandals", tags: ["summer"] },
  ];

  it("floats storm products first, preserving relative order within each group", () => {
    const out = boostByWeather(products, "storm");
    expect(out.map((p) => p.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("floats sun products first, preserving relative order within each group", () => {
    const out = boostByWeather(products, "sun");
    expect(out.map((p) => p.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("leaves order unchanged for a neutral condition", () => {
    const out = boostByWeather(products, "neutral");
    expect(out.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("does not mutate the input array", () => {
    const original = [...products];
    boostByWeather(products, "storm");
    expect(products).toEqual(original);
  });
});
