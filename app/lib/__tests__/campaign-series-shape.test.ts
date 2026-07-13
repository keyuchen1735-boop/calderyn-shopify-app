import { describe, expect, it } from "vitest";
import { aggregateSpendRows } from "../roas-series";

describe("aggregateSpendRows", () => {
  it("sums spend and revenue per day, ordered by day", () => {
    const rows = [
      { day: "2026-07-01", spend_cents: 100, revenue_attrib_cents: 300 },
      { day: "2026-07-01", spend_cents: 50, revenue_attrib_cents: 0 },
      { day: "2026-07-02", spend_cents: 200, revenue_attrib_cents: 800 },
    ];
    expect(aggregateSpendRows(rows)).toEqual([
      { day: "2026-07-01", spend_cents: 150, revenue_cents: 300 },
      { day: "2026-07-02", spend_cents: 200, revenue_cents: 800 },
    ]);
  });

  it("returns [] for no rows", () => {
    expect(aggregateSpendRows([])).toEqual([]);
  });
});
