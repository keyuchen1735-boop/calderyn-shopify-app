import type { OperatingPnlData } from "../analytics/operating-pnl";
import { apiGet } from "./client";

export type OperatingPnlDays = 7 | 14 | 30 | 90 | 365 | 3650;

export function fetchOperatingPnl(days: OperatingPnlDays): Promise<OperatingPnlData> {
  return apiGet(`/dashboard/api/analytics-pnl?days=${days}`);
}
