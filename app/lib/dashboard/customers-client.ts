// Client fetchers for the customer-directory dashboard surface. Kept in its
// own module (not client.ts) so parallel surface work never collides on one file.
import { apiGet, apiSend } from "./client";
import type { WeatherForecastDTO } from "../weather/types";
import type {
  CustomerSegment,
  CustomerStats,
  CustomerRow,
  SegmentDef,
  CustomersPage,
  CustomerAddress,
  CustomerConsent,
  CustomerOrderRow,
  CustomerCart,
  CustomerDetail,
} from "~/lib/buyer/directory-types";

export type {
  CustomerSegment,
  CustomerStats,
  CustomerRow,
  SegmentDef,
  CustomersPage,
  CustomerAddress,
  CustomerConsent,
  CustomerOrderRow,
  CustomerCart,
  CustomerDetail,
};
export type { WeatherSuggestionDTO, WeatherForecastDTO, RegionForecastDTO } from "../weather/types";

export async function fetchCustomersPage(): Promise<CustomersPage> {
  return apiGet<CustomersPage>("/dashboard/api/customers");
}

export async function fetchCustomerDetail(id: string): Promise<CustomerDetail> {
  return apiGet<CustomerDetail>(`/dashboard/api/customers/${encodeURIComponent(id)}`);
}

/** Approve now, arm for weather-triggered execution, or dismiss a prediction. */
export async function applyWeatherSuggestion(
  suggestionId: string,
  intent: "apply" | "arm" | "dismiss",
): Promise<{ ok: boolean; status: string }> {
  return apiSend("POST", "/dashboard/api/weather-reallocation", { suggestionId, intent });
}

export async function fetchWeatherForecast(): Promise<WeatherForecastDTO> {
  return apiGet("/dashboard/api/weather-forecast");
}

/** Save (or clear) the merchant's home location used for local forecasts. */
export async function saveMerchantLocation(
  lat: number | null,
  lon: number | null,
): Promise<{ ok: boolean }> {
  return apiSend("PUT", "/dashboard/api/guardrails", { merchant_lat: lat, merchant_lon: lon });
}
