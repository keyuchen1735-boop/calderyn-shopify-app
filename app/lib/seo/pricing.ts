// app/lib/seo/pricing.ts
// Shared "sellable price" resolution for the SEO/AIO surfaces (writer, site
// files, overview). A variant is sellable only when it carries a real price
// (priceCents > 0); a $0 sample is not a buyable offer. `available` reflects a
// SELLABLE variant being in stock, so a product whose only in-stock variant is
// a free sample reads as out of stock at its real price rather than "in stock"
// for a price no one can buy.
import type { StoreProduct, StoreVariant } from "~/lib/storefront/catalog";

export interface SellablePrice {
  priceCents: number; // lowest sellable price in cents; 0 when nothing is for sale
  currency: string; // currency of the sellable variants; "" when none
  available: boolean; // a sellable variant is in stock
}

/** The variants a shopper can actually buy (priceCents > 0). Single source of
 *  truth for "what is sellable" so the three SEO surfaces never diverge. */
export function sellableVariants(product: StoreProduct): StoreVariant[] {
  return product.variants.filter((v) => v.priceCents > 0);
}

export function sellablePrice(product: StoreProduct): SellablePrice {
  const sellable = sellableVariants(product);
  if (sellable.length === 0) return { priceCents: 0, currency: "", available: false };
  return {
    priceCents: Math.min(...sellable.map((v) => v.priceCents)),
    currency: sellable[0].currency,
    available: sellable.some((v) => v.available),
  };
}
