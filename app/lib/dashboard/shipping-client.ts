// Client fetchers for the dashboard Shipping surface. Kept in its own module
// (not client.ts) so parallel surface work never collides on one file.
import { apiGet, apiSend } from "./client";
import type {
  CarrierServiceDto,
  FlatRateRowView,
  Quotes30dSummary,
  RateCardRow,
  RateSourceKindView,
  ShipCoverage,
  ShipOriginDto,
  ShippingSummary,
  ShipRulesDtoView,
} from "~/lib/shipping/summary-types";

export type {
  CarrierServiceDto,
  FlatRateRowView,
  Quotes30dSummary,
  RateCardRow,
  RateSourceKindView,
  ShipCoverage,
  ShipOriginDto,
  ShippingSummary,
  ShipRulesDtoView,
};

export async function fetchShippingSummary(): Promise<ShippingSummary> {
  return apiGet<ShippingSummary>("/dashboard/api/shipping");
}

/** Every shipping-settings write returns the refreshed summary (one authoritative repaint). */
export async function postShippingSettings(
  body: Record<string, unknown>,
): Promise<ShippingSummary> {
  return apiSend<ShippingSummary>("POST", "/dashboard/api/shipping", body);
}
