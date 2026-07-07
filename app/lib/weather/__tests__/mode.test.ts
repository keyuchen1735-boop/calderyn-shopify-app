import { describe, it, expect } from "vitest";
import { weatherMode, sensitivityForMode } from "../types";

describe("weatherMode", () => {
  it("maps the sensitivity dial to the three merchant-facing modes", () => {
    expect(weatherMode(0)).toBe("off");
    expect(weatherMode(50)).toBe("approve");
    expect(weatherMode(100)).toBe("auto");
  });
});

describe("sensitivityForMode", () => {
  it("off zeroes the dial and auto pins it to the auto threshold", () => {
    expect(sensitivityForMode("off", 50)).toBe(0);
    expect(sensitivityForMode("auto", 50)).toBe(100);
  });

  it("approve keeps a merchant's existing mid-range dial instead of clobbering it", () => {
    expect(sensitivityForMode("approve", 30)).toBe(30);
  });

  it("approve picks a sane default when coming from off or auto", () => {
    expect(sensitivityForMode("approve", 0)).toBe(50);
    expect(sensitivityForMode("approve", 100)).toBe(50);
  });
});
