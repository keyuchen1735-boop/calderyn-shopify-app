import type { OperatingPnlData } from "../analytics/operating-pnl";
import { apiGet } from "./client";

export function fetchOperatingPnl(days: 7 | 14 | 30): Promise<OperatingPnlData> {
  return apiGet(`/dashboard/api/analytics-pnl?days=${days}`);
}
