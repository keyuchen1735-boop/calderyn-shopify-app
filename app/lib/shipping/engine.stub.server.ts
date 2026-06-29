// ponytail: passthrough stub so #6.4 (CarrierService callback) can build and run
// against the frozen contract before #6.3's real engine lands. Applies NO merchant
// rules, maps carrier options 1:1, single-parcel-by-weight. Deterministic. The real
// engine (parcel packing, markup/free-ship/zone rules, delivery windows, caching) is
// #6.3 in ./engine.impl.server.ts; getShippingEngine() swaps to it in one line.
import { createHash } from "node:crypto";
import type { QuoteShipping, ShippingQuote, ShippingQuoteOption } from "./quote";
import type { RateRequest } from "../ship-cost/adapters/rate-quote";

/** Stable hash over the canonicalized request — same input, same key (idempotency). */
export function hashShippingRequest(req: Parameters<QuoteShipping>[0]): string {
  const canonical = JSON.stringify({
    cart: req.cart.map((l) => ({ v: l.variantId, q: l.quantity, w: l.weightOz ?? null })),
    sub: req.cartSubtotalCents,
    to: req.destination,
    from: req.origin,
    cur: req.currency,
    opt: req.options ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export const stubQuoteShipping: QuoteShipping = async (req, rateSource) => {
  // Single-parcel-by-weight: collapse cart lines into one parcel. v1 dims are 0 —
  // the adapter degrades to weight-band fallback when carrier dims are required.
  const weightOz = req.cart.reduce((sum, l) => sum + (l.weightOz ?? 0) * l.quantity, 0);
  const rateReq: RateRequest = {
    origin: req.origin,
    destination: req.destination,
    parcels: [{ lengthIn: 0, widthIn: 0, heightIn: 0, weightOz }],
    serviceFilter: req.options?.serviceFilter,
  };

  const result = await rateSource.getRates(rateReq);
  const options: ShippingQuoteOption[] = result.options.map((o) => ({
    service: o.serviceCode,
    serviceName: o.serviceName,
    carrier: o.carrier,
    amountCents: o.amountCents,
    baseAmountCents: o.amountCents,
    appliedRules: [], // stub applies no merchant rules
    currency: o.currency,
    deliveryWindow: o.deliveryDateEstimate
      ? { earliest: o.deliveryDateEstimate, latest: o.deliveryDateEstimate }
      : null,
    guaranteed: o.guaranteed,
    pickupAvailable: false,
  }));

  const quote: ShippingQuote = {
    options,
    currency: req.currency,
    source: result.fallbackUsed ? "fallback" : "carrier",
    fallbackUsed: result.fallbackUsed,
    requestHash: hashShippingRequest(req),
  };
  return quote;
};
