import { describe, it, expect } from "vitest";
import { sparklinePath } from "../sparkline";

describe("sparklinePath", () => {
  it("returns an empty path for fewer than two points (nothing to draw)", () => {
    expect(sparklinePath([], 100, 30)).toBe("");
    expect(sparklinePath([7], 100, 30)).toBe("");
  });

  it("maps a rising two-point series to the full inner box, bottom-left to top-right", () => {
    // min 0, max 10: first point sits at the bottom (y=27), last at the top (y=3);
    // x spans the 2px inner padding on each side of a 100px-wide box.
    expect(sparklinePath([0, 10], 100, 30)).toBe("M2.0 27.0 L98.0 3.0");
  });

  it("draws a flat line through the vertical middle-bottom when all values are equal", () => {
    // Zero range is clamped to 1 so a flat series renders a straight line, not NaN.
    expect(sparklinePath([5, 5], 100, 30)).toBe("M2.0 27.0 L98.0 27.0");
  });

  it("spaces interior points evenly across the width", () => {
    // 3 points → x at 2, 50, 98 (half-width steps over the 96px inner span).
    const d = sparklinePath([0, 5, 10], 100, 30);
    expect(d).toBe("M2.0 27.0 L50.0 15.0 L98.0 3.0");
  });

  it("never emits NaN coordinates for a valid multi-point series", () => {
    const d = sparklinePath([3, 1, 4, 1, 5, 9, 2], 96, 28);
    expect(d).not.toContain("NaN");
    expect(d.startsWith("M")).toBe(true);
  });
});
