// Typed errors for the shipping/quote path. Kept dependency-free (no server-only
// imports) so callers can catch by `instanceof` without pulling in the data layer.

// Thrown by the quote path when a cart contains one or more items that cannot ship to
// the buyer's destination country (destination is in variant_shipping.restricted_countries).
// Checkout/storefront catch this (by `code` or instanceof) and tell the buyer which items
// to remove, rather than quoting an order that could never be fulfilled.
// Thrown when the buyer's chosen shipping option can no longer be quoted (the carrier
// rate vanished or the engine degraded to fallback between offer and pay). Callers
// re-offer fresh options rather than silently charging a different service's price.
export class ShippingOptionUnavailableError extends Error {
  readonly code = "SHIPPING_OPTION_UNAVAILABLE" as const;
  readonly service: string;

  constructor(service: string) {
    super(`shipping option ${service} is no longer available; re-quote and re-offer`);
    this.name = "ShippingOptionUnavailableError";
    this.service = service;
  }
}

export class ShipRestrictedError extends Error {
  readonly code = "SHIP_RESTRICTED" as const;
  readonly destinationCountry: string;
  readonly variantIds: string[];

  constructor(destinationCountry: string, variantIds: string[]) {
    super(`cannot ship ${variantIds.length} item(s) to ${destinationCountry}: ${variantIds.join(", ")}`);
    this.name = "ShipRestrictedError";
    this.destinationCountry = destinationCountry;
    this.variantIds = variantIds;
  }
}
