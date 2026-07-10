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
  /** Merchant-set instructions under the option (today: the local-pickup note). */
  note?: string;
}

// The buyer's shipping choice is a CARRIER-QUALIFIED token, not a bare service code: two
// carriers can share a code ("Express"), and a code-only round trip would let the pay step
// silently price a different carrier's rate than the one the buyer clicked. Pure string
// helpers, browser-safe — quoteCart (server) and the checkout UI share one token grammar.
const TOKEN_SEP = "::";

export function shippingOptionToken(carrier: string, service: string): string {
  return `${carrier}${TOKEN_SEP}${service}`;
}

export function parseShippingOptionToken(token: string): { carrier: string; service: string } | null {
  const idx = token.indexOf(TOKEN_SEP);
  if (idx <= 0 || idx + TOKEN_SEP.length >= token.length) return null;
  return { carrier: token.slice(0, idx), service: token.slice(idx + TOKEN_SEP.length) };
}

// Local pickup. The pickup choice rides the same token protocol as a carrier rate but is
// priced by a branch INSIDE quoteCart (never the rate engine). The checkout UI keys its
// "Ready <date>" copy off these constants.
export const PICKUP_OPTION_TOKEN = shippingOptionToken("PICKUP", "PICKUP");
/** orders.shipping_service value for a pickup order — what confirmations and emails display. */
export const PICKUP_SERVICE_NAME = "Store pickup";
