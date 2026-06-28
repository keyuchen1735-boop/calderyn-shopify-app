// EasyPost adapter (rate-quote / buyer-facing direction). Reuses the cost adapter's
// HTTP Basic + base-URL + money parsing (easypost.server.ts) and credential load
// (integration_credentials kind 'easypost_ship' via crypto.server.ts). Hits the
// rate-shopping flow: POST /v2/shipments, then reads ALL rates[] (NOT selected_rate).
//
// No new npm dependency (repo rule P6): built-in fetch + HTTP Basic + AbortController.

import { parseRateToCents } from "./easypost.server";
import type { NormalizedRateOption } from "./rate-quote";

/** Shape of one element of an EasyPost shipment's `rates[]` (fields we read). */
export interface EasyPostRateQuote {
  carrier?: string | null;
  service?: string | null;
  rate?: string | null; // list rate, decimal STRING e.g. "7.39".
  currency?: string | null;
  delivery_days?: number | null;
  est_delivery_days?: number | null;
  delivery_date?: string | null;
  delivery_date_guaranteed?: boolean | null;
}

/**
 * Pure mapper: one EasyPost rate → NormalizedRateOption, or null to DROP.
 * Drop when carrier/service is missing (can't present an option) or the rate is
 * malformed/negative (parseRateToCents → null) — never coerce a bad rate to 0 (rule 12).
 */
export function mapRateToOption(r: EasyPostRateQuote): NormalizedRateOption | null {
  const carrier = r.carrier?.trim();
  const service = r.service?.trim();
  if (!carrier || !service) return null;
  const amountCents = parseRateToCents(r.rate);
  if (amountCents == null) return null; // malformed/negative → drop, surfaced as a missing option.
  return {
    carrier,
    serviceCode: service,
    serviceName: service, // ponytail: serviceCode === serviceName until a display map exists.
    amountCents,
    currency: r.currency?.trim() || "USD",
    estTransitDays: r.delivery_days ?? r.est_delivery_days ?? null,
    guaranteed: r.delivery_date_guaranteed === true,
    deliveryDateEstimate: r.delivery_date ?? null,
    rateType: "list", // v1: EasyPost `rate` is the list rate; negotiated is v2.
  };
}
