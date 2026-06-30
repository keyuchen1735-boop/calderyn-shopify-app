// Storefront delivery-promise: a COARSE shipping estimate (no exact street address, no tax).
// Shows the buyer "delivered by <date>" + cheapest/fastest BEFORE checkout. Always flagged
// isEstimate=true — the coarse destination means the exact checkout rate can differ, so the
// widget must label it an estimate (avoids a bait-and-switch perception, rule 12).
import type { ShippingQuoteRequest } from "~/lib/shipping/quote";
import { getShippingEngine } from "~/lib/shipping/engine.server";
import { priceLines } from "~/lib/order/cart.server";
import type { QuoteLine } from "./types";
import { getShopOrigin } from "./origin.server";
import { getRateSource } from "./rate-source.server";

export interface CoarseDestination {
  zip: string;
  country: string;
  state?: string;
}

export interface EstimateOption {
  serviceName: string;
  carrier: string;
  amountCents: number;
  deliveryEarliest: string | null;
  deliveryLatest: string | null;
}

export interface ShippingEstimate {
  cheapest: EstimateOption;
  fastest: EstimateOption;
  currency: string;
  isEstimate: true;
}

function toOption(o: {
  serviceName: string;
  carrier: string;
  amountCents: number;
  deliveryWindow: { earliest: string; latest: string } | null;
}): EstimateOption {
  return {
    serviceName: o.serviceName,
    carrier: o.carrier,
    amountCents: o.amountCents,
    deliveryEarliest: o.deliveryWindow?.earliest ?? null,
    deliveryLatest: o.deliveryWindow?.latest ?? null,
  };
}

export async function estimateShipping(
  shopId: string,
  lines: QuoteLine[],
  dest: CoarseDestination,
): Promise<ShippingEstimate> {
  if (!shopId) throw new Error("shopId is required");
  if (!lines.length) throw new Error("at least one line is required to estimate");

  const priced = await priceLines(shopId, lines);
  const origin = await getShopOrigin(shopId);
  // getRateSource is async (throws RATE_SOURCE_NOT_CONFIGURED when no carrier connected).
  const rateSource = await getRateSource(shopId);

  // Coarse destination: zip + country (+ state if known). Street/city blank — EasyPost rates
  // primarily on zip+country; the engine flags lowConfidence which we surface as isEstimate.
  const req: ShippingQuoteRequest = {
    cart: priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    cartSubtotalCents: priced.subtotalCents,
    origin,
    destination: { street1: "", city: "", state: dest.state ?? "", zip: dest.zip, country: dest.country },
    currency: priced.currency,
    options: { selection: "all" },
  };
  const quote = await getShippingEngine()(req, rateSource);
  if (!quote.options.length) throw new Error("no shipping options for the coarse destination");

  const byPrice = [...quote.options].sort((a, b) => a.amountCents - b.amountCents);
  const dateKey = (o: { deliveryWindow: { latest: string } | null }) =>
    o.deliveryWindow ? Date.parse(o.deliveryWindow.latest) : Number.POSITIVE_INFINITY;
  const bySpeed = [...quote.options].sort((a, b) => dateKey(a) - dateKey(b));

  return {
    cheapest: toOption(byPrice[0]),
    fastest: toOption(bySpeed[0]),
    currency: quote.currency,
    isEstimate: true,
  };
}
