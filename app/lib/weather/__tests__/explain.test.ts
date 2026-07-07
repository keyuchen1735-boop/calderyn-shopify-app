import { describe, it, expect } from "vitest";
import { explainMove } from "../explain";

const fc = (over: Partial<{ avgTempC: number; precipMm: number; snowCm: number; score: number }>) => ({
  avgTempC: 20,
  precipMm: 0,
  snowCm: 0,
  score: 0.2,
  ...over,
});

describe("explainMove", () => {
  it("explains a rainy destination in short plain words", () => {
    const out = explainMove({
      sourceName: "West",
      destName: "East",
      source: fc({ avgTempC: 24, precipMm: 0, score: 0.21 }),
      dest: fc({ avgTempC: 18, precipMm: 18, score: 0.44 }),
    });
    expect(out.headline).toBe("Rain in East — more people shop online");
    expect(out.factors).toEqual([
      { icon: "rain", label: "18mm rain · East" },
      { icon: "user", label: "more buyers · East" },
      { icon: "sun", label: "sunny · West" },
    ]);
    expect(out.note).toBe("Sunny in West — people are out, not browsing.");
  });

  it("snow outranks rain as the named driver", () => {
    const out = explainMove({
      sourceName: "West",
      destName: "Central",
      source: fc({}),
      dest: fc({ precipMm: 22, snowCm: 4, score: 0.5 }),
    });
    expect(out.headline).toBe("Snow in Central — more people shop online");
    expect(out.factors[0]).toEqual({ icon: "snowflake", label: "4cm snow · Central" });
  });

  it("a cold dry destination is explained by the cold, in °F", () => {
    const out = explainMove({
      sourceName: "South",
      destName: "East",
      source: fc({}),
      dest: fc({ avgTempC: 1, score: 0.4 }),
    });
    expect(out.headline).toBe("Cold in East — more people shop online");
    expect(out.factors[0]).toEqual({ icon: "snowflake", label: "34° · East" });
  });

  it("still explains the move when forecasts are unavailable", () => {
    const out = explainMove({ sourceName: "West", destName: "East", source: null, dest: null });
    expect(out.headline).toBe("Weather sends more East shoppers online");
    expect(out.factors).toEqual([]);
    expect(out.note).toBeUndefined();
  });
});
