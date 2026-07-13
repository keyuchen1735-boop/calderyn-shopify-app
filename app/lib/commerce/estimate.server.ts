// Storefront delivery-promise: a COARSE shipping estimate (no exact street address, no tax).
// Shows the buyer "delivered by <date>" + cheapest/fastest BEFORE checkout. Always flagged
// isEstimate=true — the coarse destination means the exact checkout rate can differ, so the
// widget must label it an estimate (avoids a bait-and-switch perception, rule 12).
import type { ShippingQuoteRequest } from "~/lib/shipping/quote";
import { getShippingEngine } from "~/lib/shipping/engine.server";
import { priceLines } from "~/lib/order/cart.server";
import type { QuoteLine } from "./types";
import { getShopOrigin } from "./origin.server";
import { RateSourceNotConfiguredError, resolveRateSource } from "./rate-source.server";
import { cartShipInfo } from "~/lib/shipping/parcel.server";
import { ShipRestrictedError } from "~/lib/shipping/errors";
import { loadShipRules, toMerchantShipRules } from "~/lib/shipping/rules.server";

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

  // Fail fast: don't promise a delivery date for an item we can't ship to the destination
  // country. Same restriction rule (and same merchant rules) as quoteCart so the
  // pre-checkout estimate never contradicts what checkout will do. Independent shop reads
  // run alongside the batched ship-data read.
  const [shipInfo, rulesDto, origin, resolvedSource] = await Promise.all([
    cartShipInfo(priced.lines.map((l) => l.variantId), dest.country),
    loadShipRules(shopId),
    getShopOrigin(shopId),
    resolveRateSource(shopId),
  ]);
  if (shipInfo.blocked.length) throw new ShipRestrictedError(dest.country, shipInfo.blocked);
  const rules = toMerchantShipRules(rulesDto, shipInfo.maxHandlingDays);

  // Checkout always quotes (a zero-setup shop sells at the default bands), but a PROMISE
  // is different: never advertise a delivery date/price on the PDP that came from the
  // built-in bands the merchant never saw. The delivery-promise route maps this to a
  // 422 and the widget hides (rule 12: no invented dates).
  if (resolvedSource.kind === "default") throw new RateSourceNotConfiguredError(shopId);
  const rateSource = resolvedSource.source;

  // Coarse destination: zip + country (+ state if known). Street/city blank — EasyPost rates
  // primarily on zip+country; the engine flags lowConfidence which we surface as isEstimate.
  // A variant without ship data quotes as a bare line -> engine low-confidence fallback.
  const cart = priced.lines.map((l) => {
    const parcel = shipInfo.parcelByVariant.get(l.variantId);
    const base = { variantId: l.variantId, quantity: l.quantity };
    return parcel
      ? { ...base, weightOz: parcel.weightOz, lengthIn: parcel.lengthIn, widthIn: parcel.widthIn, heightIn: parcel.heightIn }
      : base;
  });

  const req: ShippingQuoteRequest = {
    cart,
    cartSubtotalCents: priced.subtotalCents,
    origin,
    destination: { street1: "", city: "", state: dest.state ?? "", zip: dest.zip, country: dest.country },
    currency: priced.currency,
    options: { selection: "all" },
  };
  const quote = await getShippingEngine()(req, rateSource, rules);
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
