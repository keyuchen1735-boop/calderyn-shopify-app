// Shared, provider-blind RATE-QUOTE connector contract — the buyer-facing /
// pre-purchase direction of the ship-cost adapter family. Where ShipCostAdapter
// (adapter.ts) reads ACTUAL PAID charges for analytics, RateQuoteAdapter returns
// LIVE CARRIER RATE OPTIONS for a given origin/destination/parcel. Callers never
// branch on carrier — exactly like the cost side. Money is integer cents.

import type { ShipProvider, ShipIntegrationKind } from "./adapter";

/** A postal address, provider-blind (the adapter maps it to the carrier body). */
export interface Address {
  name?: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string; // ISO-2, default "US".
  phone?: string;
}

/** One package's dims + weight, provider-blind (mapped to the carrier body). */
export interface Parcel {
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  weightOz: number;
}

/** The input to a rate quote. */
export interface RateRequest {
  origin: Address;
  destination: Address;
  // Array for forward-compat; v1 reads parcels[0] only (single-parcel;
  // upgrade path = multi-parcel packing in #6.3).
  parcels: Parcel[];
  // Optional client-side filter to a set of serviceCodes; v1 filters after the
  // call rather than as a server-side constraint.
  serviceFilter?: string[];
}

/** One carrier rate OPTION, normalized across providers (callers never branch). */
export interface NormalizedRateOption {
  carrier: string; // e.g. "USPS"
  serviceCode: string; // e.g. "Priority"
  serviceName: string; // v1: serviceCode === serviceName until a display map exists
  amountCents: number; // integer cents via parseRateToCents; never coerced to 0
  currency: string; // ISO-4217, default "USD"
  estTransitDays: number | null;
  guaranteed: boolean;
  deliveryDateEstimate: string | null;
  // Provenance for #6.3 margin reconciliation. v1 is always "list"
  // (EasyPost `rate` = list rate; negotiated needs attached carrier_accounts).
  // v1 ships list rates only; upgrade path = negotiated rates in v2.
  rateType: "list" | "negotiated";
}

/** The result of a rate quote: options plus degraded-mode + latency visibility. */
export interface RateQuoteResult {
  options: NormalizedRateOption[];
  fallbackUsed: boolean;
  latencyMs: number;
  provider: ShipProvider;
}

/** Per-shop, already-authenticated handle that fetches live rate options. */
export interface RateQuoteSource {
  // Runtime. NEVER throws on carrier slowness/down — degrades to the static
  // fallback table (fallbackUsed: true). See easypost-rate.server.ts.
  getRates(req: RateRequest): Promise<RateQuoteResult>;
}

/** A provider plug. `connect` returns null when the shop has NO credential stored. */
export interface RateQuoteAdapter {
  readonly provider: ShipProvider;
  readonly integrationKind: ShipIntegrationKind;
  // null = no credential stored (shop not connected).
  // THROW = a credential is stored but structurally broken (failure-visibility, rule 12).
  connect(shopId: string): Promise<RateQuoteSource | null>;
}
