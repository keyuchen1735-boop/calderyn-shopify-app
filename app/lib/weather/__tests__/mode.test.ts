import { describe, it, expect } from "vitest";
import { weatherMode, sensitivityForMode } from "../types";

describe("weatherMode", () => {
  it("maps the sensitivity dial to the two merchant-facing modes", () => {
    // No "off" mode: any dial below the auto threshold reads as manual —
    // the merchant approves, rejects, or schedules each move.
    expect(weatherMode(0)).toBe("manual");
    expect(weatherMode(50)).toBe("manual");
    expect(weatherMode(100)).toBe("auto");
  });
});

describe("sensitivityForMode", () => {
  it("auto pins the dial to the auto threshold", () => {
    expect(sensitivityForMode("auto", 50)).toBe(100);
  });

  it("manual keeps a merchant's existing mid-range dial instead of clobbering it", () => {
    expect(sensitivityForMode("manual", 30)).toBe(30);
  });

  it("manual picks a sane default when coming from a zero or auto dial", () => {
    expect(sensitivityForMode("manual", 0)).toBe(50);
    expect(sensitivityForMode("manual", 100)).toBe(50);
  });
});
