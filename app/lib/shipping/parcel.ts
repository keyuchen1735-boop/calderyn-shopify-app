// Parcel assembly (#6.3). v1 = single-parcel-by-weight: collapse every cart line
// into ONE parcel whose weight is sum(weightOz * quantity). Dims are a best-effort
// single-box estimate (max per axis across the lines that carry dims). Multi-box /
// freight detection is an explicit v2 — NOT built here.
import type { Parcel } from "../ship-cost/adapters/rate-quote";
import type { ShippingQuoteLine } from "./quote";

export interface AssembledParcels {
  parcels: Parcel[];
  // True when any line lacks weight or full dims, so the quote rests on estimated
  // packaging. Surfaced to callers/tests for confidence; the carrier still receives
  // weight (the band driver) so a quote is always produced.
  lowConfidence: boolean;
}

/** Largest value of one axis across the lines that provide it, else 0. */
function maxAxis(cart: ShippingQuoteLine[], pick: (l: ShippingQuoteLine) => number | undefined): number {
  return cart.reduce((max, l) => {
    const v = pick(l);
    return v != null && v > max ? v : max;
  }, 0);
}

/** Pack the cart into a single weight-based parcel (v1). Always returns one parcel. */
export function assembleParcels(cart: ShippingQuoteLine[]): AssembledParcels {
  const weightOz = cart.reduce((sum, l) => sum + (l.weightOz ?? 0) * l.quantity, 0);
  const lowConfidence = cart.some(
    (l) => l.weightOz == null || l.lengthIn == null || l.widthIn == null || l.heightIn == null,
  );
  const parcel: Parcel = {
    lengthIn: maxAxis(cart, (l) => l.lengthIn),
    widthIn: maxAxis(cart, (l) => l.widthIn),
    heightIn: maxAxis(cart, (l) => l.heightIn),
    weightOz,
  };
  return { parcels: [parcel], lowConfidence };
}
