import { describe, expect, it } from "vitest";
import {
  DASHBOARD_SIDEBAR_WIDTH,
  STORE_SIDEBAR_COMPACT_WIDTH,
  shouldCompactStoreSidebar,
} from "../store-sidebar-focus";

describe("store builder sidebar focus mode", () => {
  it("compacts automatically only for the storefront builder", () => {
    expect(shouldCompactStoreSidebar("storefront", false)).toBe(true);
    expect(shouldCompactStoreSidebar("dashboard", false)).toBe(false);
    expect(shouldCompactStoreSidebar("catalog", false)).toBe(false);
  });

  it("lets the merchant restore the full navigation while building", () => {
    expect(shouldCompactStoreSidebar("storefront", true)).toBe(false);
    expect(STORE_SIDEBAR_COMPACT_WIDTH).toBeLessThan(DASHBOARD_SIDEBAR_WIDTH / 2);
  });
});
