// Client fetchers for the dashboard Shipping surface. Kept in its own module
// (not client.ts) so parallel surface work never collides on one file.
import { apiGet } from "./client";
import type {
  CarrierServiceDto,
  Quotes30dSummary,
  RateCardRow,
  ShipCoverage,
  ShipOriginDto,
  ShippingSummary,
} from "~/lib/shipping/summary-types";

export type {
  CarrierServiceDto,
  Quotes30dSummary,
  RateCardRow,
  ShipCoverage,
  ShipOriginDto,
  ShippingSummary,
};

export async function fetchShippingSummary(): Promise<ShippingSummary> {
  return apiGet<ShippingSummary>("/dashboard/api/shipping");
}
