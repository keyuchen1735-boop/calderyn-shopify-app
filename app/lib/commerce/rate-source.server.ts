// The RateQuoteSource the shipping engine calls, resolved in priority order:
//   1. Live carrier (EasyPost credential) — accurate carrier rates.
//   2. Merchant flat rates (ship_flat_rate rows) — the shop's own configured prices.
//   3. Built-in default bands — flagged fallbackUsed so the dashboard can nudge the
//      merchant to configure real rates.
// A shop with ZERO shipping setup can therefore always quote and sell (no rate =
// no sale, same posture as the engine); "not configured" is surfaced as a visible
// fallback stat, never as a dead checkout.
import type { RateQuoteResult, RateQuoteSource, RateRequest } from "~/lib/ship-cost/adapters/rate-quote";
import { buildFallbackOptions, easyPostRateAdapter } from "~/lib/ship-cost/adapters/easypost-rate.server";
import { buildMerchantFlatRateSource, loadFlatRates } from "~/lib/shipping/flat-rate.server";

/** Retained for callers that still catch it defensively; getRateSource no longer throws it. */
export class RateSourceNotConfiguredError extends Error {
  code = "RATE_SOURCE_NOT_CONFIGURED" as const;
  constructor(shopId: string) {
    super(`shop ${shopId} has no connected shipping carrier; connect EasyPost before quoting`);
  }
}

/** Which source getRateSource resolved — surfaced on the dashboard Shipping screen. */
export type RateSourceKind = "carrier" | "flat" | "default";

function defaultBandsSource(shopId: string): RateQuoteSource {
  return {
    id: `default-bands:${shopId}`,
    getRates(req: RateRequest): Promise<RateQuoteResult> {
      const start = Date.now();
      return Promise.resolve({
        options: buildFallbackOptions(req),
        // Honest signal: the shop never configured rates, so every quote from here
        // counts into the dashboard's "fallback rate used" stat.
        fallbackUsed: true,
        latencyMs: Date.now() - start,
        provider: "merchant",
      });
    },
  };
}

export async function resolveRateSource(
  shopId: string,
): Promise<{ source: RateQuoteSource; kind: RateSourceKind }> {
  if (!shopId) throw new Error("shopId is required");
  // connect() null = not connected; a stored-but-broken credential still THROWS
  // (failure-visibility) rather than silently downgrading the shop to flat rates.
  const carrier = await easyPostRateAdapter.connect(shopId);
  if (carrier) return { source: carrier, kind: "carrier" };
  const flatRates = await loadFlatRates(shopId);
  if (flatRates.length > 0) {
    return { source: buildMerchantFlatRateSource(shopId, flatRates), kind: "flat" };
  }
  return { source: defaultBandsSource(shopId), kind: "default" };
}

export async function getRateSource(shopId: string): Promise<RateQuoteSource> {
  return (await resolveRateSource(shopId)).source;
}
