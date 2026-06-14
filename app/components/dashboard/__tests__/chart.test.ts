// The overview/analytics AreaChart renders revenue/spend straight into SVG path
// coordinates and a hover tooltip's blended-ROAS number. Two real prod hazards:
//   - a zero-spend day made the tooltip show "Infinity×" (or "NaN×")
//   - an all-zero-revenue series made maxV=0, so every y() coordinate was NaN and
//     the whole chart path broke.
// blendedRoas() is the pure tooltip formatter; the SSR render asserts the chart
// math never emits NaN/Infinity on degenerate data.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { blendedRoas } from "../format";
import { AreaChart } from "../ui";
import type { DailyRow } from "../view-models";

describe("blendedRoas", () => {
  it("formats revenue/spend as a ROAS multiple", () => {
    expect(blendedRoas(30_000, 10_000)).toBe("3.0×");
  });

  it("returns an em dash when spend is zero (no Infinity)", () => {
    expect(blendedRoas(30_000, 0)).toBe("—");
  });

  it("returns an em dash when both are zero (no NaN)", () => {
    expect(blendedRoas(0, 0)).toBe("—");
  });

  it("returns an em dash on non-finite input", () => {
    expect(blendedRoas(NaN, 100)).toBe("—");
  });
});

describe("AreaChart degenerate data", () => {
  function rows(make: (i: number) => DailyRow, n = 30): DailyRow[] {
    return Array.from({ length: n }, (_, i) => make(i));
  }

  it("emits no NaN/Infinity path coordinates when all revenue is zero", () => {
    const allZeroRevenue = rows((i) => ({
      daysAgo: 29 - i,
      spend_cents: 5_000,
      revenue_cents: 0,
    }));
    const html = renderToString(createElement(AreaChart, { rows: allZeroRevenue }));
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });

  it("emits no NaN with a single data point", () => {
    const single: DailyRow[] = [{ daysAgo: 0, spend_cents: 1000, revenue_cents: 2000 }];
    const html = renderToString(createElement(AreaChart, { rows: single }));
    expect(html).not.toContain("NaN");
  });
});
