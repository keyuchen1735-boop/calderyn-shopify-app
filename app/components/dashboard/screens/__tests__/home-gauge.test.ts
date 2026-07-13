import { describe, expect, it } from "vitest";
import { homeGaugeView } from "../home-gauge";

describe("homeGaugeView", () => {
  it("holds at 0/pending before boot, even when a stale pct already arrived", () => {
    expect(homeGaugeView(false, false, 47)).toEqual({ pct: 0, pending: true });
  });
  it("stays at 0 (not pending) once booted and dormant", () => {
    expect(homeGaugeView(true, true, 47)).toEqual({ pct: 0, pending: false });
  });
  it("resolves to the real pct once booted and not dormant", () => {
    expect(homeGaugeView(true, false, 55)).toEqual({ pct: 55, pending: false });
  });
  it("treats a missing pct as 0 after boot", () => {
    expect(homeGaugeView(true, false, null)).toEqual({ pct: 0, pending: false });
  });
});
