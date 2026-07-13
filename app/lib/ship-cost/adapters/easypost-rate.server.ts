// EasyPost adapter (rate-quote / buyer-facing direction). Reuses the cost adapter's
// HTTP Basic + base-URL + money parsing (easypost.server.ts) and credential load
// (integration_credentials kind 'easypost_ship' via crypto.server.ts). Hits the
// rate-shopping flow: POST /v2/shipments, then reads ALL rates[] (NOT selected_rate).
//
// No new npm dependency (repo rule P6): built-in fetch + HTTP Basic + AbortController.

import { parseRateToCents, basicAuthHeader, apiBase, loadEasyPostApiKey } from "./easypost.server";
import type {
  Address,
  NormalizedRateOption,
  Parcel,
  RateQuoteAdapter,
  RateQuoteResult,
  RateQuoteSource,
  RateRequest,
} from "./rate-quote";

const RATE_TIMEOUT_MS = 5000; // hard p95 budget; carrier slowness must not block checkout.

/** Shape of one element of an EasyPost shipment's `rates[]` (fields we read). */
export interface EasyPostRateQuote {
  carrier?: string | null;
  service?: string | null;
  rate?: string | null; // list rate, decimal STRING e.g. "7.39".
  currency?: string | null;
  delivery_days?: number | null;
  est_delivery_days?: number | null;
  delivery_date?: string | null;
  delivery_date_guaranteed?: boolean | null;
}

/**
 * Pure mapper: one EasyPost rate → NormalizedRateOption, or null to DROP.
 * Drop when carrier/service is missing (can't present an option) or the rate is
 * malformed/negative (parseRateToCents → null) — never coerce a bad rate to 0 (rule 12).
 */
export function mapRateToOption(r: EasyPostRateQuote): NormalizedRateOption | null {
  const carrier = r.carrier?.trim();
  const service = r.service?.trim();
  if (!carrier || !service) return null;
  const amountCents = parseRateToCents(r.rate);
  if (amountCents == null) return null; // malformed/negative → drop, surfaced as a missing option.
  return {
    carrier,
    serviceCode: service,
    serviceName: service, // ponytail: serviceCode === serviceName until a display map exists.
    amountCents,
    currency: r.currency?.trim() || "USD",
    estTransitDays: r.delivery_days ?? r.est_delivery_days ?? null,
    guaranteed: r.delivery_date_guaranteed === true,
    deliveryDateEstimate: r.delivery_date ?? null,
    rateType: "list", // v1: EasyPost `rate` is the list rate; negotiated is v2.
  };
}

// Static fallback rate table — conservative cents by weight band, surfaced when the
// carrier is slow/down/empty so the caller always has a quote (no rate = no sale).
// ponytail: hardcoded constant table; upgrade path = the merchant-configurable
// ship_fallback_rate table owned by #6.3 (master spec §282).
interface FallbackBand {
  maxWeightOz: number;
  economyCents: number;
  expeditedCents: number;
}

const FALLBACK_BANDS: FallbackBand[] = [
  { maxWeightOz: 16, economyCents: 599, expeditedCents: 1299 },
  { maxWeightOz: 48, economyCents: 999, expeditedCents: 1899 },
  { maxWeightOz: 160, economyCents: 1599, expeditedCents: 2999 },
];
const FALLBACK_TOP = { economyCents: 2499, expeditedCents: 4499 }; // > 160 oz.

/**
 * Conservative static rate options for the given request, by parcel weight band.
 * Always non-empty. Exported so the #6.3 engine reuses the same table rather than
 * re-implementing it. Options are never guaranteed and carry no firm delivery date.
 */
export function buildFallbackOptions(req: RateRequest): NormalizedRateOption[] {
  const weightOz = req.parcels?.[0]?.weightOz ?? 0; // ponytail: single-parcel; optional-chain the array too so a missing parcels[] still degrades, never throws (contract).
  const band = FALLBACK_BANDS.find((b) => weightOz <= b.maxWeightOz);
  const economyCents = band ? band.economyCents : FALLBACK_TOP.economyCents;
  const expeditedCents = band ? band.expeditedCents : FALLBACK_TOP.expeditedCents;
  return [
    {
      carrier: "Standard",
      serviceCode: "Economy",
      serviceName: "Economy",
      amountCents: economyCents,
      currency: "USD",
      estTransitDays: 7,
      guaranteed: false,
      deliveryDateEstimate: null,
      rateType: "list",
    },
    {
      carrier: "Standard",
      serviceCode: "Expedited",
      serviceName: "Expedited",
      amountCents: expeditedCents,
      currency: "USD",
      estTransitDays: 3,
      guaranteed: false,
      deliveryDateEstimate: null,
      rateType: "list",
    },
  ];
}

/** Provider-blind Address → EasyPost address body (shared with the label adapter so the
 *  quote and the purchased label always post the same address shape). */
export function toEasyPostAddress(a: Address): Record<string, unknown> {
  return {
    name: a.name,
    company: a.company,
    street1: a.street1,
    street2: a.street2,
    city: a.city,
    state: a.state,
    zip: a.zip,
    country: a.country || "US",
    phone: a.phone,
  };
}

/** Provider-blind Parcel → EasyPost parcel body (weight in OUNCES). Shared with the label adapter. */
export function toEasyPostParcel(p: Parcel): Record<string, unknown> {
  return { length: p.lengthIn, width: p.widthIn, height: p.heightIn, weight: p.weightOz };
}

/** Shape of the POST /v2/shipments response (fields we read). */
interface EasyPostShipmentRates {
  rates?: EasyPostRateQuote[] | null;
}

/**
 * Create a shipment and read ALL of its rate options, provider-blind. v1 quotes
 * parcels[0] only. NEVER throws at runtime: on abort/timeout, network error,
 * non-2xx, malformed body, or empty rates[] it returns the static fallback with
 * fallbackUsed:true (load-bearing — no rate = no sale). connect() keeps throw
 * semantics; this runtime path degrades.
 */
export async function fetchEasyPostRates(
  apiKey: string,
  req: RateRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<RateQuoteResult> {
  const start = Date.now();
  const parcel = req.parcels?.[0]; // ponytail: single-parcel; multi-parcel packing is #6.3. Optional-chain so missing parcels degrades, never throws (contract).
  const fallback = (): RateQuoteResult => ({
    options: buildFallbackOptions(req),
    fallbackUsed: true,
    latencyMs: Date.now() - start,
    provider: "easypost",
  });
  if (!parcel) return fallback(); // nothing to quote → degrade, never throw.

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RATE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${apiBase()}/shipments`, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(apiKey),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        shipment: {
          to_address: toEasyPostAddress(req.destination),
          from_address: toEasyPostAddress(req.origin),
          parcel: toEasyPostParcel(parcel),
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return fallback(); // non-2xx at RUNTIME → degrade (flagged), never throw.
    const json = (await res.json()) as EasyPostShipmentRates;
    const rawRates = json.rates ?? [];
    let options = rawRates
      .map(mapRateToOption)
      .filter((o): o is NormalizedRateOption => o !== null);
    if (req.serviceFilter && req.serviceFilter.length > 0) {
      const allow = new Set(req.serviceFilter); // ponytail: client-side filter, not server-side.
      options = options.filter((o) => allow.has(o.serviceCode));
    }
    if (options.length === 0) return fallback(); // empty rates[] / all-dropped → degrade.
    return { options, fallbackUsed: false, latencyMs: Date.now() - start, provider: "easypost" };
  } catch {
    // abort/timeout/network/malformed-body → degrade, NEVER propagate (load-bearing).
    return fallback();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Provider plug. connect() is CONFIG-TIME and keeps the cost-side semantics:
 *   null  = no credential stored (shop not connected)
 *   THROW = a credential is stored but structurally broken (decrypt fails / db error)
 * Runtime carrier failures are handled by fetchEasyPostRates' degrade path, not here.
 */
export const easyPostRateAdapter: RateQuoteAdapter = {
  provider: "easypost",
  integrationKind: "easypost_ship",
  async connect(shopId: string): Promise<RateQuoteSource | null> {
    // Shared load: null = shop not connected; throws on broken ciphertext (rule 12).
    const apiKey = await loadEasyPostApiKey(shopId);
    if (!apiKey) return null;
    return {
      // Scope the shared quote cache to this shop+provider so no other tenant is
      // ever served these rates (see RateQuoteSource.id / quote cache keying).
      id: `easypost:${shopId}`,
      getRates: (req: RateRequest) => fetchEasyPostRates(apiKey, req),
    };
  },
};
