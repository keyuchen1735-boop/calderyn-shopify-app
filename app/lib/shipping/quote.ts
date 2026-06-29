// Single-source-of-truth SHIPPING QUOTE contract (#6.3). The deterministic core
// every surface calls — checkout (#6.4 CarrierService), storefront, buy-in-chat —
// so they can never disagree on price. Pure types here (client-importable); the
// engine implementation is server-only (engine.server.ts). Money is integer cents.
import type { Address, RateQuoteSource } from "../ship-cost/adapters/rate-quote";

export type { Address, RateQuoteSource };

/** One cart line to be shipped. Dims/weight may be pre-resolved by the caller;
 *  when absent the engine falls back to weight bands during parcel assembly. */
export interface ShippingQuoteLine {
  variantId: string;
  quantity: number;
  weightOz?: number;
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
}

/** Merchant rule inputs. Each rule is applied explicitly and recorded in
 *  ShippingQuoteOption.appliedRules — never silently averaged (rule 7). */
export interface MerchantShipRules {
  markupPct?: number; // e.g. 10 = +10% on the carrier amount
  handlingCents?: number; // flat handling added per shipment
  freeShipThresholdCents?: number; // cart subtotal at/above which shipping is free
  // Zone overrides are intentionally minimal for v1; richer matchers are a #6.3 v2 upgrade.
}

export type SelectionStrategy = "all" | "cheapest" | "fastest" | "blended";

/** The input to a shipping quote. */
export interface ShippingQuoteRequest {
  cart: ShippingQuoteLine[];
  cartSubtotalCents: number; // evaluated against freeShipThresholdCents
  origin: Address;
  destination: Address;
  currency: string; // ISO-4217
  options?: {
    serviceFilter?: string[];
    selection?: SelectionStrategy; // default "all"
  };
}

/** Earliest/latest delivery dates (ISO-8601), assembled from carrier transit + handling. */
export interface DeliveryWindow {
  earliest: string;
  latest: string;
}

/** One quote option after merchant rules. Carries provenance for auditability (rule 7). */
export interface ShippingQuoteOption {
  service: string; // serviceCode
  serviceName: string;
  carrier: string;
  amountCents: number; // merchant-facing price after rules (0 when free-ship applies)
  baseAmountCents: number; // pre-rule carrier amount — auditable, never averaged
  appliedRules: string[]; // e.g. ["markup:10%", "handling:500", "freeship"]
  currency: string;
  deliveryWindow: DeliveryWindow | null;
  guaranteed: boolean;
  pickupAvailable: boolean;
}

/** Canonical shipping quote shared by every surface. */
export interface ShippingQuote {
  options: ShippingQuoteOption[];
  currency: string;
  source: "carrier" | "fallback";
  fallbackUsed: boolean; // true when degraded to the static fallback (rule 12 visibility)
  // true when parcel assembly had to guess (missing dims/weight) — surfaces low
  // confidence to consuming surfaces rather than hiding it (rule 12). v1.1 addition.
  lowConfidence: boolean;
  requestHash: string; // idempotency/cache key over the canonicalized request
}

/** The single function every surface calls. Deterministic, no model-in-the-loop (rule 5),
 *  idempotent + cacheable by requestHash, and ALWAYS returns something safe (fallback). */
export type QuoteShipping = (
  req: ShippingQuoteRequest,
  rateSource: RateQuoteSource,
  rules?: MerchantShipRules,
) => Promise<ShippingQuote>;
