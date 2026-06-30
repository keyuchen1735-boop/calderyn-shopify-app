// The RateQuoteSource the shipping engine calls, resolved from the shop's connected carrier
// credential (EasyPost) via the existing adapter. Mirrors the origin require-setup discipline:
// a shop with no connected carrier cannot get an accurate rate, so we fail visibly (rule 12)
// rather than invent one. The engine's static fallback still covers transient carrier OUTAGES.
import type { RateQuoteSource } from "~/lib/ship-cost/adapters/rate-quote";
import { easyPostRateAdapter } from "~/lib/ship-cost/adapters/easypost-rate.server";

export class RateSourceNotConfiguredError extends Error {
  code = "RATE_SOURCE_NOT_CONFIGURED" as const;
  constructor(shopId: string) {
    super(`shop ${shopId} has no connected shipping carrier; connect EasyPost before quoting`);
  }
}

export async function getRateSource(shopId: string): Promise<RateQuoteSource> {
  if (!shopId) throw new Error("shopId is required");
  const source = await easyPostRateAdapter.connect(shopId); // null = carrier not connected
  if (!source) throw new RateSourceNotConfiguredError(shopId);
  return source;
}
