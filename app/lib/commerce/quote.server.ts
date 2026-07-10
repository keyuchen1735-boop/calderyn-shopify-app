// app/lib/commerce/quote.server.ts
// quoteCart() — THE single source of truth for an order's price. subtotal (live catalog) +
// real shipping (#6.3 engine, merchant rules applied) + Stripe Tax. Every surface (checkout,
// storefront widget, ACP, MCP) calls this; none re-computes price. quoteCartOptions() is the
// buyer-facing option list for the same request (no tax — the chosen option is priced by a
// follow-up quoteCart). Money is integer cents.
import type { MerchantShipRules, ShippingQuoteOption, ShippingQuoteRequest } from "~/lib/shipping/quote";
import type { RateQuoteSource } from "~/lib/ship-cost/adapters/rate-quote";
import { getShippingEngine } from "~/lib/shipping/engine.server";
import { priceLines } from "~/lib/order/cart.server";
import type { CartQuote, CartShippingOption, PricedLine, QuoteDestination, QuoteLine } from "./types";
import { getShopOrigin } from "./origin.server";
import { getRateSource } from "./rate-source.server";
import { calculateTax } from "./tax.server";
import { cartShipInfo } from "~/lib/shipping/parcel.server";
import { ShipRestrictedError, ShippingOptionUnavailableError } from "~/lib/shipping/errors";
import { loadShipRules, toMerchantShipRules } from "~/lib/shipping/rules.server";

/** How many choices the buyer sees at checkout; the cheapest and the fastest always survive. */
const MAX_BUYER_OPTIONS = 5;

// The buyer's choice is a CARRIER-QUALIFIED token, not a bare service code: two
// carriers can share a code ("Express"), and a code-only round trip would let the
// pay step silently price a different carrier's rate than the one the buyer clicked.
const TOKEN_SEP = "::";

export function shippingOptionToken(carrier: string, service: string): string {
  return `${carrier}${TOKEN_SEP}${service}`;
}

function parseShippingOptionToken(token: string): { carrier: string; service: string } | null {
  const idx = token.indexOf(TOKEN_SEP);
  if (idx <= 0 || idx + TOKEN_SEP.length >= token.length) return null;
  return { carrier: token.slice(0, idx), service: token.slice(idx + TOKEN_SEP.length) };
}

interface PreparedQuote {
  priced: { lines: PricedLine[]; subtotalCents: number; currency: string };
  cart: ShippingQuoteRequest["cart"];
  origin: QuoteDestination;
  rules: MerchantShipRules;
  rateSource: RateQuoteSource;
}

/**
 * The shared front half of every quote: price the lines, enforce the destination
 * restriction gate, assemble parcels, resolve origin + merchant rules + rate source.
 * Restrictions, per-variant handling, and parcel dims ride ONE batched read
 * (cartShipInfo); the shop-scoped reads (rules, origin, rate source) run alongside
 * it since none depends on another.
 */
async function prepareQuote(
  shopId: string,
  lines: QuoteLine[],
  destination: QuoteDestination,
): Promise<PreparedQuote> {
  if (!shopId) throw new Error("shopId is required");
  if (!lines.length) throw new Error("at least one line is required to quote");

  const priced = await priceLines(shopId, lines);

  const [shipInfo, rulesDto, origin, rateSource] = await Promise.all([
    cartShipInfo(priced.lines.map((l) => l.variantId), destination.country),
    loadShipRules(shopId),
    getShopOrigin(shopId), // throws ORIGIN_NOT_CONFIGURED if unset
    getRateSource(shopId),
  ]);

  // Fail fast before any rate work: an order containing an item we cannot ship to the
  // destination country can never be fulfilled, so reject the whole quote with a typed
  // error the caller surfaces to the buyer (which items to remove) rather than quoting it.
  if (shipInfo.blocked.length) throw new ShipRestrictedError(destination.country, shipInfo.blocked);

  // A variant without ship data quotes as a bare line → engine low-confidence fallback
  // (never blocks the sale).
  const cart = priced.lines.map((l) => {
    const parcel = shipInfo.parcelByVariant.get(l.variantId);
    const base = { variantId: l.variantId, quantity: l.quantity };
    return parcel
      ? { ...base, weightOz: parcel.weightOz, lengthIn: parcel.lengthIn, widthIn: parcel.widthIn, heightIn: parcel.heightIn }
      : base;
  });

  return {
    priced,
    cart,
    origin,
    // The slowest item's handling window stretches the shop-level rule (never shrinks it).
    rules: toMerchantShipRules(rulesDto, shipInfo.maxHandlingDays),
    rateSource,
  };
}

function buildRequest(
  prepared: PreparedQuote,
  subtotalCents: number,
  destination: QuoteDestination,
  options: ShippingQuoteRequest["options"],
): ShippingQuoteRequest {
  return {
    cart: prepared.cart,
    cartSubtotalCents: subtotalCents, // free-ship thresholds evaluate on the authoritative subtotal
    origin: prepared.origin,
    destination,
    currency: prepared.priced.currency,
    options,
  };
}

export async function quoteCart(
  shopId: string,
  lines: QuoteLine[],
  destination: QuoteDestination,
  opts: { subtotalCentsOverride?: number; shippingService?: string | null } = {},
): Promise<CartQuote> {
  const prepared = await prepareQuote(shopId, lines, destination);
  const { priced, rules } = prepared;

  // Authoritative subtotal: callers holding a pre-priced/snapshot subtotal (checkout's cart)
  // pass it so tax + total match what is actually charged; agentic callers omit it and use the
  // live price. quoteCart remains the single composer either way.
  const subtotalCents = opts.subtotalCentsOverride ?? priced.subtotalCents;

  const chosenToken = opts.shippingService ? parseShippingOptionToken(opts.shippingService) : null;
  if (opts.shippingService && !chosenToken) {
    // A malformed token can't be priced as anything the buyer was offered.
    throw new ShippingOptionUnavailableError(opts.shippingService);
  }

  const req = buildRequest(
    prepared,
    subtotalCents,
    destination,
    chosenToken
      ? { serviceFilter: [chosenToken.service], selection: "cheapest" }
      : { selection: "cheapest" },
  );
  const shipQuote = await getShippingEngine()(req, prepared.rateSource, rules);
  const chosen = shipQuote.options[0];
  if (!chosen) throw new Error("shipping engine returned no options");
  // A buyer-chosen option must be priced as ITSELF — same carrier AND service. If the
  // rate vanished between offer and pay, the engine's filtered request degrades to the
  // fallback table (different carrier/service) — surface that as a typed re-offer
  // instead of charging a swap.
  if (chosenToken && (chosen.service !== chosenToken.service || chosen.carrier !== chosenToken.carrier)) {
    throw new ShippingOptionUnavailableError(opts.shippingService as string);
  }
  const shippingCents = chosen.amountCents;

  const taxCents = await calculateTax({
    currency: priced.currency,
    subtotalCents,
    shippingCents,
    destination,
  });

  return {
    lines: priced.lines,
    subtotalCents,                       // authoritative subtotal
    shippingCents,
    taxCents,
    totalCents: subtotalCents + shippingCents + taxCents,
    currency: priced.currency,
    deliveryEarliest: chosen.deliveryWindow?.earliest ?? null,
    deliveryLatest: chosen.deliveryWindow?.latest ?? null,
    lowConfidence: shipQuote.lowConfidence,
    fallbackUsed: shipQuote.fallbackUsed,
    shippingService: chosen.serviceName || chosen.service,
  };
}

function toCartOption(o: ShippingQuoteOption): CartShippingOption {
  const label =
    o.carrier && o.carrier !== o.serviceName && o.carrier !== "Standard"
      ? `${o.carrier} ${o.serviceName}`
      : o.serviceName;
  return {
    service: shippingOptionToken(o.carrier, o.service),
    label,
    amountCents: o.amountCents,
    deliveryEarliest: o.deliveryWindow?.earliest ?? null,
    deliveryLatest: o.deliveryWindow?.latest ?? null,
  };
}

/**
 * The buyer's shipping choices at checkout: every serviceable option, deduped by
 * carrier+service token keeping the CHEAPEST occurrence, capped at MAX_BUYER_OPTIONS
 * sorted cheapest-first — with the fastest-arriving option always kept even when it
 * isn't among the cheapest. No tax here: the chosen option is priced authoritatively
 * by quoteCart afterwards.
 */
export async function quoteCartOptions(
  shopId: string,
  lines: QuoteLine[],
  destination: QuoteDestination,
  opts: { subtotalCentsOverride?: number } = {},
): Promise<{ options: CartShippingOption[]; currency: string }> {
  const prepared = await prepareQuote(shopId, lines, destination);
  const subtotalCents = opts.subtotalCentsOverride ?? prepared.priced.subtotalCents;

  const req = buildRequest(prepared, subtotalCents, destination, { selection: "all" });
  const shipQuote = await getShippingEngine()(req, prepared.rateSource, prepared.rules);
  if (!shipQuote.options.length) throw new Error("shipping engine returned no options");

  // Sort BEFORE dedupe so a duplicated carrier+service keeps its cheapest price —
  // first-seen order would let a pricier duplicate shadow the rate the buyer should get.
  const byPrice = [...shipQuote.options].sort((a, b) => a.amountCents - b.amountCents);
  const seen = new Set<string>();
  const deduped = byPrice.filter((o) => {
    const token = shippingOptionToken(o.carrier, o.service);
    if (seen.has(token)) return false;
    seen.add(token);
    return true;
  });
  const arrival = (o: ShippingQuoteOption) =>
    o.deliveryWindow ? Date.parse(o.deliveryWindow.earliest) : Number.POSITIVE_INFINITY;
  const fastest = deduped.reduce((best, o) => (arrival(o) < arrival(best) ? o : best));

  const shortlist = deduped.slice(0, MAX_BUYER_OPTIONS);
  if (!shortlist.some((o) => o.carrier === fastest.carrier && o.service === fastest.service)) {
    shortlist[shortlist.length - 1] = fastest;
  }

  return { options: shortlist.map(toCartOption), currency: prepared.priced.currency };
}
