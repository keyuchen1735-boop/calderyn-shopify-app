// Browser fetcher for the commerce-analytics read model consumed by the
// Analytics Performance view. Client-only (rides apiGet); types are shared
// with the server aggregation via ~/lib/analytics/commerce-types.
import { apiGet } from "./client";
import type {
  CommerceAnalytics,
  CommerceWindowDays,
} from "~/lib/analytics/commerce-types";

export type { CommerceAnalytics, CommerceWindowDays };

export async function fetchCommerceAnalytics(
  days: CommerceWindowDays,
): Promise<CommerceAnalytics> {
  return apiGet<CommerceAnalytics>(`/dashboard/api/analytics-commerce?days=${days}`);
}
