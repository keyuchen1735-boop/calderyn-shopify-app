import { describe, expect, it } from "vitest";
import { allocateOperatingExpenses, buildOperatingPnlProducts, columnStartDate, parseQuickBooksCashFlow, parseQuickBooksReport } from "../operating-pnl";

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

  // Title formats observed live on the sandbox 1Y/All reports. Date.parse read
  // the day-range titles as years ("Jul 22-31, 2025" -> 2031-07-22).
  it("derives each summarized column's start date from its title grammar", () => {
    expect(columnStartDate({ ColTitle: "Jul 22-31, 2025" })).toBe("2025-07-22");
    expect(columnStartDate({ ColTitle: "Jul 1-21, 2026" })).toBe("2026-07-01");
    expect(columnStartDate({ ColTitle: "Aug 2025" })).toBe("2025-08-01");
    expect(columnStartDate({ ColTitle: "Dec 2017" })).toBe("2017-12-01");
    expect(columnStartDate({ ColTitle: "Jul 24, 2016 - Jul 23, 2017" })).toBe("2016-07-24");
    expect(columnStartDate({ ColTitle: "2026-06-22" })).toBe("2026-06-22");
    expect(columnStartDate({ ColTitle: "Total" })).toBe("");
    expect(columnStartDate({})).toBe("");
  });

  it("prefers the structured MetaData StartDate over the title", () => {
    expect(
      columnStartDate({
        ColTitle: "Jul 22-31, 2025",
        MetaData: [{ Name: "StartDate", Value: "2025-07-22" }, { Name: "EndDate", Value: "2025-07-31" }],
      }),
    ).toBe("2025-07-22");
    // A malformed MetaData value falls back to the title.
    expect(
      columnStartDate({ ColTitle: "Aug 2025", MetaData: [{ Name: "StartDate", Value: "garbage" }] }),
    ).toBe("2025-08-01");
  });

  it("keeps partial edge periods in the per-period series with correct dates", () => {
    const report = {
      Columns: { Column: [
        { ColTitle: "Account" },
        { ColTitle: "Jul 22-31, 2025" },
        { ColTitle: "Aug 2025" },
        { ColTitle: "Total" },
      ] },
      Rows: { Row: [
        { Summary: { ColData: [{ value: "Net Income" }, { value: "10.00" }, { value: "20.00" }, { value: "30.00" }] } },
      ] },
    };
    expect(parseQuickBooksReport(report).daily).toEqual([
      { date: "2025-07-22", netIncomeCents: 1_000 },
      { date: "2025-08-01", netIncomeCents: 2_000 },
    ]);
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

  it("allocates nothing when there is no revenue to weight against", () => {
    const rows = allocateOperatingExpenses([
      { id: "a", netRevenueCents: 0, contributionCents: 0 },
      { id: "b", netRevenueCents: 0, contributionCents: 0 },
    ], 5_000);

    expect(rows.map((row) => row.allocatedOperatingExpensesCents)).toEqual([0, 0]);
    expect(rows.map((row) => row.netOperatingProfitCents)).toEqual([0, 0]);
  });

  it("reconciles every product column to the QuickBooks statement", () => {
    const rows = buildOperatingPnlProducts([
      { id: "a", title: "A", sku: null, imageUrl: null, netRevenueCents: 60_00, cogsCents: 20_00, contributionCents: 40_00 },
      { id: "b", title: "B", sku: null, imageUrl: null, netRevenueCents: 40_00, cogsCents: 30_00, contributionCents: 10_00 },
    ], { incomeCents: 125_01, cogsCents: 51_01, netIncomeCents: 41_01 });

    expect(rows.reduce((sum, row) => sum + row.netRevenueCents, 0)).toBe(125_01);
    expect(rows.reduce((sum, row) => sum + row.cogsCents, 0)).toBe(51_01);
    expect(rows.reduce((sum, row) => sum + row.allocatedOperatingExpensesCents, 0)).toBe(32_99);
    expect(rows.reduce((sum, row) => sum + row.netOperatingProfitCents, 0)).toBe(41_01);
    expect(rows).toContainEqual(expect.objectContaining({
      title: "Unattributed QuickBooks activity",
      netRevenueCents: 25_01,
      cogsCents: 1_01,
      allocatedOperatingExpensesCents: 6_60,
      netOperatingProfitCents: 17_40,
    }));
  });

  it("reads the final cash change from the QuickBooks cash-flow report", () => {
    expect(parseQuickBooksCashFlow({ Rows: { Row: [
      { Summary: { ColData: [{ value: "Net cash provided by operating activities" }, { value: "125.20" }] } },
      { Summary: { ColData: [{ value: "Net increase in cash" }, { value: "80.10" }] } },
    ] } })).toBe(8_010);
  });
});
