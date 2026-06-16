import { describe, it, expect } from "vitest";
import { formatShipPnl } from "../ship-pnl";

describe("formatShipPnl", () => {
  it("formats a positive P&L with a + sign and 'pos' tone", () => {
    expect(formatShipPnl(1800)).toEqual({ label: "+$18", tone: "pos" });
  });

  it("formats a negative P&L (free-ship leakage) with a - sign and 'neg' tone", () => {
    expect(formatShipPnl(-21400)).toEqual({ label: "-$214", tone: "neg" });
  });

  it("renders an exact zero as $0 with a 'zero' tone", () => {
    expect(formatShipPnl(0)).toEqual({ label: "$0", tone: "zero" });
  });

  it("renders no-data (null = no in-window order with a resolved cost) as a dash", () => {
    expect(formatShipPnl(null)).toEqual({ label: "—", tone: "zero" });
  });

  it("rounds magnitude symmetrically across sign (no loss-understatement bias)", () => {
    expect(formatShipPnl(-150)).toEqual({ label: "-$2", tone: "neg" });
    expect(formatShipPnl(150)).toEqual({ label: "+$2", tone: "pos" });
  });

  it("rounds a sub-dollar magnitude to whole dollars and collapses it to $0", () => {
    expect(formatShipPnl(-30)).toEqual({ label: "$0", tone: "zero" });
  });

  it("adds a thousands separator on large magnitudes", () => {
    expect(formatShipPnl(-1234500)).toEqual({ label: "-$12,345", tone: "neg" });
  });
});
