import { describe, expect, it } from "vitest";
import { parsePath, pathFor } from "../routes";

describe("Analytics operating P&L route", () => {
  it("round-trips the QuickBooks-gated subtab URL", () => {
    const nav = { screen: "analytics" as const, param: null, sub: "pnl" };
    expect(pathFor(nav)).toBe("/dashboard/analytics/pnl");
    expect(parsePath("/dashboard/analytics/pnl")).toEqual(nav);
  });
});
