// Delivery-window assembly (#6.3). Combine carrier transit (estTransitDays /
// deliveryDateEstimate) with a simple origin handling offset into earliest/latest
// ISO-8601 dates. The handling band IS the window's spread: earliest assumes the
// order ships today (best case); latest assumes it ships after the handling offset
// (worst case). No invented buffers, no prediction — that pluggability is #6.6.
import type { NormalizedRateOption } from "../ship-cost/adapters/rate-quote";
import type { DeliveryWindow } from "./quote";

// v1 default origin handling: orders ship within one day. A real per-origin /
// per-merchant offset is a #6.6 upgrade; the engine passes this through so it is
// already pluggable.
export const DEFAULT_HANDLING_DAYS = 1;

const DAY_MS = 86_400_000;

/** ISO calendar date (YYYY-MM-DD) of `date` shifted by `days` (UTC, simple v1 calendar). */
function isoDatePlus(date: Date, days: number): string {
  return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Earliest/latest delivery dates, or null when the carrier gave no transit signal.
 * Prefers an absolute carrier delivery date (most precise) over a transit-day count.
 */
export function buildDeliveryWindow(
  opt: NormalizedRateOption,
  handlingDays: number,
  now: Date,
): DeliveryWindow | null {
  if (opt.deliveryDateEstimate) {
    const arrival = new Date(opt.deliveryDateEstimate);
    if (!Number.isNaN(arrival.getTime())) {
      return { earliest: isoDatePlus(arrival, 0), latest: isoDatePlus(arrival, handlingDays) };
    }
  }
  if (opt.estTransitDays != null) {
    return {
      earliest: isoDatePlus(now, opt.estTransitDays),
      latest: isoDatePlus(now, handlingDays + opt.estTransitDays),
    };
  }
  return null;
}
