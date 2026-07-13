// Typed errors for the commerce/quote path. Kept dependency-free (no server-only
// imports) so routes can catch by `instanceof` without pulling in the origin
// resolver's Supabase/Shopify import graph (same stance as app/lib/shipping/errors.ts).

/** Thrown when a shop has no ship-from address, so nothing can be quoted. */
export class OriginNotConfiguredError extends Error {
  code = "ORIGIN_NOT_CONFIGURED" as const;
  constructor(shopId: string) {
    super(`shop ${shopId} has no ship-from address; the merchant must set one before quoting`);
  }
}
