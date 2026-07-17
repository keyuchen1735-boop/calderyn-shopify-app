import { describe, expect, it } from "vitest";
import { allocateOperatingExpenses, parseQuickBooksCashFlow, parseQuickBooksReport } from "../operating-pnl";

describe("operating P&L", () => {
  it("reads nested QuickBooks totals and daily net income from the accrual report", () => {
    const report = {
      Columns: { Column: [
        { ColTitle: "Account" },
        { ColTitle: "2026-07-14" },
        { ColTitle: "2026-07-15" },
      ] },
      Rows: { Row: [
        { Header: { ColData: [{ value: "Income" }] }, Rows: { Row: [] }, Summary: { ColData: [{ value: "Total Income" }, { value: "100.00" }, { value: "150.00" }] } },
        { Header: { ColData: [{ value: "Cost of Goods Sold" }] }, Rows: { Row: [] }, Summary: { ColData: [{ value: "Total Cost of Goods Sold" }, { value: "40.00" }, { value: "50.00" }] } },
        { Header: { ColData: [{ value: "Expenses" }] }, Rows: { Row: [
          { ColData: [{ value: "Advertising" }, { value: "10.00" }, { value: "15.00" }] },
        ] }, Summary: { ColData: [{ value: "Total Expenses" }, { value: "20.00" }, { value: "30.00" }] } },
        { Summary: { ColData: [{ value: "Net Income" }, { value: "40.00" }, { value: "70.00" }] } },
      ] },
    };

    expect(parseQuickBooksReport(report)).toMatchObject({
      incomeCents: 25_000,
      cogsCents: 9_000,
      operatingExpensesCents: 5_000,
      netIncomeCents: 11_000,
      daily: [
        { date: "2026-07-14", netIncomeCents: 4_000 },
        { date: "2026-07-15", netIncomeCents: 7_000 },
      ],
    });
  });

  it("allocates every cent of shared operating expense by net revenue", () => {
    const rows = allocateOperatingExpenses([
      { id: "a", netRevenueCents: 60_00, contributionCents: 30_00 },
      { id: "b", netRevenueCents: 40_00, contributionCents: 10_00 },
    ], 3_333);

    expect(rows.map((row) => row.allocatedOperatingExpensesCents)).toEqual([2_000, 1_333]);
    expect(rows.reduce((sum, row) => sum + row.allocatedOperatingExpensesCents, 0)).toBe(3_333);
    expect(rows.map((row) => row.netOperatingProfitCents)).toEqual([1_000, -333]);
  });

  it("reads the final cash change from the QuickBooks cash-flow report", () => {
    expect(parseQuickBooksCashFlow({ Rows: { Row: [
      { Summary: { ColData: [{ value: "Net cash provided by operating activities" }, { value: "125.20" }] } },
      { Summary: { ColData: [{ value: "Net increase in cash" }, { value: "80.10" }] } },
    ] } })).toBe(8_010);
  });
});
