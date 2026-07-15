import type { Screen } from "./context";

export const DASHBOARD_SIDEBAR_WIDTH = 220;
export const STORE_SIDEBAR_COMPACT_WIDTH = 68;

export function shouldCompactStoreSidebar(screen: Screen, expanded: boolean): boolean {
  return screen === "storefront" && !expanded;
}
