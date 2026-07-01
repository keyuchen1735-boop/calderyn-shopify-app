// Typed errors for the shipping/quote path. Kept dependency-free (no server-only
// imports) so callers can catch by `instanceof` without pulling in the data layer.

// Thrown by the quote path when a cart contains one or more items that cannot ship to
// the buyer's destination country (destination is in variant_shipping.restricted_countries).
// Checkout/storefront catch this (by `code` or instanceof) and tell the buyer which items
// to remove, rather than quoting an order that could never be fulfilled.
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
