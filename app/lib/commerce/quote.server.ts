// app/lib/commerce/quote.server.ts
// quoteCart() — THE single source of truth for an order's price. subtotal (live catalog) +
// real shipping (#6.3 engine) + Stripe Tax. Every surface (checkout, storefront widget, ACP,
// MCP) calls this; none re-computes price. Money is integer cents.
import type { ShippingQuoteRequest } from "~/lib/shipping/quote";
import { getShippingEngine } from "~/lib/shipping/engine.server";
import { priceLines } from "~/lib/order/cart.server";
import type { CartQuote, QuoteDestination, QuoteLine } from "./types";
import { getShopOrigin } from "./origin.server";
import { getRateSource } from "./rate-source.server";
import { calculateTax } from "./tax.server";

export async function quoteCart(
  shopId: string,
  lines: QuoteLine[],
  destination: QuoteDestination,
  opts: { subtotalCentsOverride?: number } = {},
): Promise<CartQuote> {
  if (!shopId) throw new Error("shopId is required");
  if (!lines.length) throw new Error("at least one line is required to quote");

  const priced = await priceLines(shopId, lines);
  // Authoritative subtotal: callers holding a pre-priced/snapshot subtotal (checkout's cart)
  // pass it so tax + total match what is actually charged; agentic callers omit it and use the
  // live price. quoteCart remains the single composer either way.
  const subtotalCents = opts.subtotalCentsOverride ?? priced.subtotalCents;
  const origin = await getShopOrigin(shopId); // throws ORIGIN_NOT_CONFIGURED if unset

  const req: ShippingQuoteRequest = {
    cart: priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    cartSubtotalCents: subtotalCents, // free-ship thresholds evaluate on the authoritative subtotal
    origin,
    destination,
    currency: priced.currency,
    options: { selection: "cheapest" },
  };
  const shipQuote = await getShippingEngine()(req, await getRateSource(shopId));
  const cheapest = shipQuote.options[0];
  if (!cheapest) throw new Error("shipping engine returned no options");
  const shippingCents = cheapest.amountCents;

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
    deliveryEarliest: cheapest.deliveryWindow?.earliest ?? null,
    deliveryLatest: cheapest.deliveryWindow?.latest ?? null,
    lowConfidence: shipQuote.lowConfidence,
    fallbackUsed: shipQuote.fallbackUsed,
  };
}
