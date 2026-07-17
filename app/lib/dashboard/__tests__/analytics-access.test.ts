import { describe, expect, it } from "vitest";
import { canViewOperatingPnl } from "../analytics-access";

describe("QuickBooks analytics access", () => {
  it("unlocks operating P&L only for a paired QuickBooks connection", () => {
    expect(canViewOperatingPnl([{ key: "quickbooks", status: "connected" }])).toBe(true);
    expect(canViewOperatingPnl([{ key: "quickbooks", status: "pending" }])).toBe(true);
    expect(canViewOperatingPnl([{ key: "quickbooks", status: "reauth" }])).toBe(false);
    expect(canViewOperatingPnl([])).toBe(false);
  });
});
