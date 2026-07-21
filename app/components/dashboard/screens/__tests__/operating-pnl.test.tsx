import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { cacheScreenData, clearScreenCache, operatingPnlCacheKey } from "~/lib/dashboard/screen-cache";
import type { OperatingPnlData } from "~/lib/analytics/operating-pnl";
import OperatingPnl from "../OperatingPnl";

const data: OperatingPnlData = {
  connected: true,
  currency: "USD",
  startDate: "2026-07-01",
  endDate: "2026-07-30",
  netCashFlowCents: 0,
  products: [],
  statement: {
    incomeCents: 100_00,
    cogsCents: 40_00,
    operatingExpensesCents: 20_00,
    netIncomeCents: 40_00,
    rows: [],
    daily: [
      { date: "2026-07-01", netIncomeCents: 10_00 },
      { date: "2026-07-15", netIncomeCents: 10_00 },
      { date: "2026-07-30", netIncomeCents: 20_00 },
    ],
  },
};

describe("Operating P&L", () => {
  afterEach(clearScreenCache);

  it("labels the daily chart with its visible date range", () => {
    cacheScreenData(operatingPnlCacheKey(30), data);

    const html = renderToStaticMarkup(<OperatingPnl />);

    expect(html).toContain("Jul 1");
    expect(html).toContain("Jul 30");
  });
});
