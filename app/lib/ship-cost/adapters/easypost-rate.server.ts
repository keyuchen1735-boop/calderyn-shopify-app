// EasyPost adapter (rate-quote / buyer-facing direction). Reuses the cost adapter's
// HTTP Basic + base-URL + money parsing (easypost.server.ts) and credential load
// (integration_credentials kind 'easypost_ship' via crypto.server.ts). Hits the
// rate-shopping flow: POST /v2/shipments, then reads ALL rates[] (NOT selected_rate).
//
// No new npm dependency (repo rule P6): built-in fetch + HTTP Basic + AbortController.

import { parseRateToCents } from "./easypost.server";
import type { NormalizedRateOption, RateRequest } from "./rate-quote";

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

// Static fallback rate table — conservative cents by weight band, surfaced when the
// carrier is slow/down/empty so the caller always has a quote (no rate = no sale).
// ponytail: hardcoded constant table; upgrade path = the merchant-configurable
// ship_fallback_rate table owned by #6.3 (master spec §282).
interface FallbackBand {
  maxWeightOz: number;
  economyCents: number;
  expeditedCents: number;
}

const FALLBACK_BANDS: FallbackBand[] = [
  { maxWeightOz: 16, economyCents: 599, expeditedCents: 1299 },
  { maxWeightOz: 48, economyCents: 999, expeditedCents: 1899 },
  { maxWeightOz: 160, economyCents: 1599, expeditedCents: 2999 },
];
const FALLBACK_TOP = { economyCents: 2499, expeditedCents: 4499 }; // > 160 oz.

/**
 * Conservative static rate options for the given request, by parcel weight band.
 * Always non-empty. Exported so the #6.3 engine reuses the same table rather than
 * re-implementing it. Options are never guaranteed and carry no firm delivery date.
 */
export function buildFallbackOptions(req: RateRequest): NormalizedRateOption[] {
  const weightOz = req.parcels[0]?.weightOz ?? 0; // ponytail: single-parcel.
  const band = FALLBACK_BANDS.find((b) => weightOz <= b.maxWeightOz);
  const economyCents = band ? band.economyCents : FALLBACK_TOP.economyCents;
  const expeditedCents = band ? band.expeditedCents : FALLBACK_TOP.expeditedCents;
  return [
    {
      carrier: "Standard",
      serviceCode: "Economy",
      serviceName: "Economy",
      amountCents: economyCents,
      currency: "USD",
      estTransitDays: 7,
      guaranteed: false,
      deliveryDateEstimate: null,
      rateType: "list",
    },
    {
      carrier: "Standard",
      serviceCode: "Expedited",
      serviceName: "Expedited",
      amountCents: expeditedCents,
      currency: "USD",
      estTransitDays: 3,
      guaranteed: false,
      deliveryDateEstimate: null,
      rateType: "list",
    },
  ];
}
