// Protocol-neutral commerce types shared by quote, order, and the adapters (P2/P3).
import type { Address } from "~/lib/ship-cost/adapters/rate-quote";

/** One line an agent (or checkout) wants quoted: a variant + quantity. */
export interface QuoteLine {
  variantId: string;
  quantity: number;
}

/** A priced line after catalog resolution (snapshot of what the buyer is shown). */
export interface PricedLine extends QuoteLine {
  unitPriceCents: number;
  currency: string;
  titleSnapshot: string;
}

/** The ship-to address. Reuses the engine's Address shape (street1/city/state/zip/country). */
export type QuoteDestination = Address;

/** The canonical quote returned by quoteCart() — the single source of truth. Money in cents. */
export interface CartQuote {
  lines: PricedLine[];
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  deliveryEarliest: string | null; // ISO-8601
  deliveryLatest: string | null;
  lowConfidence: boolean; // shipping had to guess dims/weight (rule 12)
  fallbackUsed: boolean; // shipping degraded to static fallback (rule 12)
  shippingService: string | null; // the priced option's service name (buyer-chosen or cheapest)
}

/** One buyer-facing shipping choice, surfaced by quoteCartOptions() at checkout. */
export interface CartShippingOption {
  service: string; // stable service code posted back as the buyer's choice
  label: string; // display name, e.g. "USPS Priority"
  amountCents: number;
  deliveryEarliest: string | null; // ISO calendar date
  deliveryLatest: string | null;
}
