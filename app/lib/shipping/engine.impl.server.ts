// Real shipping quote engine (#6.3) — the single source of truth every surface
// (checkout #6.4, storefront, buy-in-chat) calls. Deterministic, no model-in-the-loop
// (rule 5), idempotent + cacheable by request hash, and ALWAYS returns something safe:
// it never throws (the rate source degrades to a static fallback) and never returns an
// empty quote (no rate = no sale — it falls through to the static fallback table).
//
// Pipeline: parcel assembly → live rates (or fallback) → drop non-serviceable rates →
// merchant rules (markup/handling/free-ship) + delivery window per option → selection
// strategy. baseAmountCents preserves the pre-rule carrier amount for audit (rule 7).
import { buildFallbackOptions } from "../ship-cost/adapters/easypost-rate.server";
import type { NormalizedRateOption, Parcel, RateRequest } from "../ship-cost/adapters/rate-quote";
import { hashShippingRequest } from "./engine.stub.server";
import type {
  MerchantShipRules,
  QuoteShipping,
  ShippingQuote,
  ShippingQuoteOption,
  ShippingQuoteRequest,
} from "./quote";
import { assembleParcels } from "./parcel";
import { applyMerchantRules, selectOptions } from "./rules";
import { buildDeliveryWindow, DEFAULT_HANDLING_DAYS } from "./delivery-window";
import { QuoteCache } from "./cache";

// Short TTL: long enough to absorb a buyer's repeated re-quotes (page reloads,
// step-back-and-forward in checkout), short enough that price/rate changes surface
// quickly. Per-process only — see the CEILING note in cache.ts.
export const DEFAULT_QUOTE_TTL_MS = 60_000;

/** Injectable dependencies, so the engine stays a pure function of its inputs under test. */
export interface EngineDeps {
  now: () => Date;
  cache: QuoteCache;
  cacheTtlMs: number;
  handlingDays: number;
}

/** Canonical merchant-rules segment. Derived from the rules object's own keys (sorted)
 *  rather than a hand-listed field set, so a future MerchantShipRules field can't
 *  silently fall out of the cache key and collide on price. */
function canonicalRules(rules?: MerchantShipRules): string {
  if (!rules) return "none";
  const sorted = Object.keys(rules)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = (rules as Record<string, unknown>)[k];
      return acc;
    }, {});
  return JSON.stringify(sorted); // undefined values drop out → same key as omitting them.
}

/**
 * Cache key = request hash + merchant rules + ASSEMBLED-parcel dims fingerprint.
 * `hashShippingRequest` (reused from the stub) covers only variant/qty/weight — NOT
 * parcel dims. The engine packs dims into the carrier parcel AND derives lowConfidence
 * from them, so two carts identical but for dims MUST NOT share a cache entry: otherwise
 * a no-dims request could return a cached full-dims quote and silently report
 * lowConfidence:false (rule 12). We fingerprint the same parcels we send to getRates
 * (v1 single-parcel; mapping all keeps multi-parcel v2 correct). The quote's own
 * `requestHash` stays request-only, per the frozen contract.
 */
export function quoteCacheKey(
  req: ShippingQuoteRequest,
  rules: MerchantShipRules | undefined,
  parcels: Parcel[],
): string {
  const dims = parcels
    .map((p) => `${p.lengthIn}x${p.widthIn}x${p.heightIn}x${p.weightOz}`)
    .join(",");
  return `${hashShippingRequest(req)}:${canonicalRules(rules)}:${dims}`;
}

/** Build the engine with explicit deps (production defaults below). */
export function createQuoteEngine(deps: Partial<EngineDeps> = {}): QuoteShipping {
  const now = deps.now ?? (() => new Date());
  const cache = deps.cache ?? new QuoteCache();
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_QUOTE_TTL_MS;
  const handlingDays = deps.handlingDays ?? DEFAULT_HANDLING_DAYS;

  return async (req, rateSource, rules): Promise<ShippingQuote> => {
    // Snapshot the clock once so cache lookup, delivery windows, and cache write
    // share a single consistent "now" within this quote.
    const nowDate = now();
    const nowMs = nowDate.getTime();

    // Assemble parcels FIRST: parcel dims are part of the cache identity (see
    // quoteCacheKey) and are sent to the carrier. Pure + cheap — no carrier call yet.
    const { parcels, lowConfidence } = assembleParcels(req.cart);

    // Scope the (process-wide, cross-tenant) cache by everything that changes the quote
    // but is NOT in quoteCacheKey's request fingerprint:
    //   - the rate SOURCE identity: rates come from this shop's carrier credentials, so two
    //     shops with a byte-identical request must never share an entry (tenant isolation).
    //   - the calendar day: estTransitDays windows are anchored to `now`; without the day in
    //     the key a re-quote across midnight would serve a frozen (possibly past) delivery date.
    //   - lowConfidence: explicit zero dims and omitted dims assemble to the same parcel
    //     fingerprint but must not share an entry (rule 12: never report a cached false).
    const cacheKey = `${rateSource.id ?? ""}:${nowDate.toISOString().slice(0, 10)}:${
      lowConfidence ? "lc1" : "lc0"
    }:${quoteCacheKey(req, rules, parcels)}`;
    const cached = cache.get(cacheKey, nowMs);
    if (cached) return cached;

    const rateReq: RateRequest = {
      origin: req.origin,
      destination: req.destination,
      parcels,
      serviceFilter: req.options?.serviceFilter,
    };

    // The rate source never throws — it degrades to the static fallback internally.
    const result = await rateSource.getRates(rateReq);

    // Enforce serviceFilter HERE, source-agnostically: only the EasyPost adapter
    // filters client-side; merchant flat rates and the default bands return every
    // option. Without this, a buyer-chosen non-cheapest service on those sources
    // could never be priced as itself (the caller's chosen-service check would
    // reject every quote). An empty post-filter set degrades to fallback below.
    const serviceFilter = req.options?.serviceFilter;
    let carrierOptions =
      serviceFilter && serviceFilter.length > 0
        ? result.options.filter((o) => serviceFilter.includes(o.serviceCode))
        : result.options;

    // Restriction suppression (v1, minimal): drop non-serviceable rates. A 0/negative
    // CARRIER amount can't be a real serviceable option and must not be presented as if
    // it were free (free-ship is a merchant RULE, not a broken rate). A merchant-authored
    // $0 flat rate (provider "merchant") IS real config — "Free shipping" rows are valid
    // and must not be suppressed into the paid fallback bands. MerchantShipRules
    // carries no service/zone restriction list yet, so this is the only restriction
    // signal in v1; richer zone/service matchers are a #6.3 v2 upgrade.
    carrierOptions = carrierOptions.filter(
      (o) => o.amountCents > 0 || (o.amountCents === 0 && result.provider === "merchant"),
    );
    let fallbackUsed = result.fallbackUsed;

    // No serviceable carrier rate (empty, or all suppressed) → degrade to the static
    // fallback table so the surface always has a quote (rule 12: no rate = no sale).
    if (carrierOptions.length === 0) {
      carrierOptions = buildFallbackOptions(rateReq).filter((o) => o.amountCents > 0);
      fallbackUsed = true;
    }

    // Merchant handling window (per-quote, from ship_rules / variant handling_days)
    // overrides the engine default. Part of canonicalRules, so it is already in the
    // cache key — two quotes differing only in handling days never share an entry.
    const effectiveHandlingDays = rules?.handlingDays ?? handlingDays;
    const priced: ShippingQuoteOption[] = carrierOptions.map((o: NormalizedRateOption) =>
      applyMerchantRules(
        o,
        rules,
        req.cartSubtotalCents,
        buildDeliveryWindow(o, effectiveHandlingDays, nowDate),
      ),
    );
    const options = selectOptions(priced, req.options?.selection ?? "all");

    const quote: ShippingQuote = {
      options,
      currency: req.currency,
      source: fallbackUsed ? "fallback" : "carrier",
      fallbackUsed,
      lowConfidence, // parcel assembly guessed (missing dims/weight) — surface it (rule 12).
      requestHash: hashShippingRequest(req),
    };

    // Cache only healthy carrier quotes: caching a degraded fallback would mask carrier
    // recovery for the whole TTL (rule 12). A fallback still always returns — just uncached.
    if (!fallbackUsed) cache.set(cacheKey, quote, nowMs, cacheTtlMs);
    return quote;
  };
}

/** Production engine — process-wide cache, wall clock. The one swap target for engine.server.ts. */
export const realQuoteShipping: QuoteShipping = createQuoteEngine();
