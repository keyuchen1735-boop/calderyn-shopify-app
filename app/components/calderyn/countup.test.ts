import { describe, it, expect } from "vitest";
import { parseCountValue, formatCount, easeOutCubic } from "./countup";

describe("parseCountValue + formatCount", () => {
  const cases = ["15", "$0", "0.8×", "$1,234", "1.50", "-5%"];
  it.each(cases)("round-trips %s exactly at the target", (value) => {
    const p = parseCountValue(value);
    expect(p).not.toBeNull();
    expect(formatCount(p!.target, p!)).toBe(value);
  });

  it("formats a mid-tween value below the target", () => {
    const p = parseCountValue("$1,234")!;
    expect(formatCount(0, p)).toBe("$0");
    expect(formatCount(617, p)).toBe("$617");
    expect(formatCount(1234, p)).toBe("$1,234");
  });

  it("preserves decimal places while tweening", () => {
    const p = parseCountValue("0.8×")!;
    expect(formatCount(0, p)).toBe("0.0×");
  });

  it("returns null for non-numeric values", () => {
    expect(parseCountValue("—")).toBeNull();
    expect(parseCountValue("N/A")).toBeNull();
  });
});

describe("easeOutCubic", () => {
  it("is pinned at the endpoints and eases out", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});
