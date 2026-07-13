// DTO shapes shared by the shipping read model (summary.server.ts) and the
// dashboard client/screen. Plain types only — safe to import from the browser.

/** Merchant ship-from address (shop_origin), or null when never configured. */
export interface ShipOriginDto {
  street1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  /** Where the address came from: "shopify" (imported) | "merchant" (set by hand). */
  source: string;
}

/** Shopify CarrierService registration status, or null when never registered.
 *  Deliberately excludes the callback URL — it embeds the callback token, the
 *  sole authenticator of the public rates endpoint, so it never leaves the server. */
export interface CarrierServiceDto {
  active: boolean;
}

/** How much of the catalog carries usable shipping data (variant_shipping). */
export interface ShipCoverage {
  variantsTotal: number;
  withShipData: number;
  missingDims: number;
  restricted: number;
}

/** One row of the engine's static fallback rate card (real quoting config). */
export interface RateCardRow {
  service: string;
  carrier: string;
  amountCents: number;
  /** Delivery promise like "3–4 days" (carrier transit + handling window). */
  estDays: string;
}

/** 30-day quote activity from commerce_quote_fact. Nulls mean "no quotes yet". */
export interface Quotes30dSummary {
  count: number;
  avgShippingCents: number | null;
  fallbackSharePct: number | null;
  lowConfidenceSharePct: number | null;
  /** Average quoted delivery window, e.g. "2–6 days"; null when no quote carried one. */
  avgPromise: string | null;
}

export interface ShippingRouteOrigin {
  city: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
}

export interface ShippingRouteDestination {
  id: string;
  city: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
  orderCount: number;
}

export interface ShippingRoutes30d {
  origin: ShippingRouteOrigin | null;
  destinations: ShippingRouteDestination[];
  mappedOrderCount: number;
  unmappedOrderCount: number;
  hasInternationalDestinations: boolean;
}

export interface ShippingSummary {
  origin: ShipOriginDto | null;
  carrierService: CarrierServiceDto | null;
  coverage: ShipCoverage;
  rateCard: RateCardRow[];
  quotes30d: Quotes30dSummary;
  routes30d: ShippingRoutes30d;
}
