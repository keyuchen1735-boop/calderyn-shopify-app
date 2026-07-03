// Dashboard read-model for the Shipping screen: ship-from origin, Shopify
// CarrierService registration, catalog ship-data coverage, the quote engine's
// static fallback rate card, and 30-day quote activity. Service-role reads
// threaded by shop_id, shaped into DTOs — Supabase rows never leak to the client.
import { getSupabase } from "~/lib/supabase.server";
import { buildFallbackOptions } from "~/lib/ship-cost/adapters/easypost-rate.server";
import type { Address, RateRequest } from "~/lib/ship-cost/adapters/rate-quote";
import { DEFAULT_HANDLING_DAYS } from "./delivery-window";
import type {
  CarrierServiceDto,
  Quotes30dSummary,
  RateCardRow,
  ShipCoverage,
  ShipOriginDto,
  ShippingSummary,
} from "./summary-types";

export type {
  CarrierServiceDto,
  Quotes30dSummary,
  RateCardRow,
  ShipCoverage,
  ShipOriginDto,
  ShippingSummary,
};

const DAY_MS = 86_400_000;

// Mirrors parcel.server.ts (constant not exported there).
const G_TO_OZ = 0.0352739619;

// The fallback table steps by weight band, so the card needs a representative
// parcel. 500 g is a typical small-parcel weight and lands in the middle band.
export const RATE_CARD_SAMPLE_WEIGHT_GRAMS = 500;

// Exact-count is fetched alongside the page, so `count` stays honest even when
// a very active shop exceeds the sample; averages then cover the most recent
// QUOTE_SAMPLE_LIMIT quotes (PostgREST caps unbounded selects anyway).
const QUOTE_SAMPLE_LIMIT = 1000;

/** Structural shape of a Supabase head-count response (error carries message). */
interface CountResult {
  count: number | null;
  error: { message: string } | null;
}

function countOf(res: CountResult, table: string): number {
  if (res.error) throw new Error(`${table} count failed: ${res.error.message}`);
  return res.count ?? 0;
}

// buildFallbackOptions keys ONLY off parcels[0].weightOz (see
// easypost-rate.server.ts); the addresses are structurally required by
// RateRequest but never read on the fallback path.
function placeholderAddress(country: string): Address {
  return { street1: "", city: "", state: "", zip: "", country };
}

/**
 * The engine's static fallback rate card for a representative 500 g parcel —
 * the same table quoting degrades to when live carrier rates are unavailable
 * (real config, not an invented number). Delivery promise combines the
 * option's carrier transit days with the default origin handling window,
 * matching buildDeliveryWindow's earliest/latest spread.
 */
export function buildRateCard(originCountry: string): RateCardRow[] {
  const req: RateRequest = {
    origin: placeholderAddress(originCountry),
    destination: placeholderAddress(originCountry),
    parcels: [
      {
        lengthIn: 0,
        widthIn: 0,
        heightIn: 0,
        weightOz: RATE_CARD_SAMPLE_WEIGHT_GRAMS * G_TO_OZ,
      },
    ],
  };
  return buildFallbackOptions(req).map((o) => ({
    service: o.serviceName,
    carrier: o.carrier,
    amountCents: o.amountCents,
    estDays:
      o.estTransitDays != null
        ? `${o.estTransitDays}–${o.estTransitDays + DEFAULT_HANDLING_DAYS} days`
        : "—",
  }));
}

async function loadOrigin(shopId: string): Promise<ShipOriginDto | null> {
  const { data, error } = await getSupabase()
    .from("shop_origin")
    .select("street1, city, state, zip, country, source")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw new Error(`shop_origin read failed: ${error.message}`);
  if (!data) return null;
  return {
    street1: String(data.street1 ?? ""),
    city: String(data.city ?? ""),
    state: String(data.state ?? ""),
    zip: String(data.zip ?? ""),
    country: String(data.country ?? "US"),
    source: String(data.source ?? "shopify"),
  };
}

async function loadCarrierService(shopId: string): Promise<CarrierServiceDto | null> {
  // Never select callback_url here: it embeds the callback token — the sole
  // authenticator of the public rates endpoint — and must not reach a browser.
  const { data, error } = await getSupabase()
    .from("ship_carrier_service_registration")
    .select("active")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) {
    throw new Error(`ship_carrier_service_registration read failed: ${error.message}`);
  }
  if (!data) return null;
  return { active: Boolean(data.active) };
}

async function loadCoverage(shopId: string): Promise<ShipCoverage> {
  const sb = getSupabase();
  const [total, withData, missingDims, restricted] = await Promise.all([
    sb
      .from("variant_dim")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopId),
    sb
      .from("variant_shipping")
      .select("variant_id", { count: "exact", head: true })
      .eq("shop_id", shopId),
    sb
      .from("variant_shipping")
      .select("variant_id", { count: "exact", head: true })
      .eq("shop_id", shopId)
      .or("length_mm.is.null,width_mm.is.null,height_mm.is.null"),
    sb
      .from("variant_shipping")
      .select("variant_id", { count: "exact", head: true })
      .eq("shop_id", shopId)
      .neq("restricted_countries", "{}"),
  ]);
  return {
    variantsTotal: countOf(total, "variant_dim"),
    withShipData: countOf(withData, "variant_shipping"),
    missingDims: countOf(missingDims, "variant_shipping (dims)"),
    restricted: countOf(restricted, "variant_shipping (restricted)"),
  };
}

async function loadQuotes30d(shopId: string): Promise<Quotes30dSummary> {
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const { data, error, count } = await getSupabase()
    .from("commerce_quote_fact")
    .select(
      "shipping_cents, fallback_used, low_confidence, delivery_earliest, delivery_latest, created_at",
      { count: "exact" },
    )
    .eq("shop_id", shopId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(QUOTE_SAMPLE_LIMIT);
  if (error) throw new Error(`commerce_quote_fact read failed: ${error.message}`);
  const rows = data ?? [];
  const total = count ?? rows.length;
  if (rows.length === 0) {
    return {
      count: total,
      avgShippingCents: null,
      fallbackSharePct: null,
      lowConfidenceSharePct: null,
      avgPromise: null,
    };
  }

  const n = rows.length;
  const avgShippingCents = Math.round(
    rows.reduce((a, r) => a + Number(r.shipping_cents ?? 0), 0) / n,
  );
  const fallbackSharePct = Math.round(
    (rows.filter((r) => Boolean(r.fallback_used)).length / n) * 100,
  );
  const lowConfidenceSharePct = Math.round(
    (rows.filter((r) => Boolean(r.low_confidence)).length / n) * 100,
  );

  // Average quoted delivery window: days from quote creation to the promised
  // earliest/latest dates, over quotes that carried a window. delivery_* are
  // ISO calendar dates (text); skip rows that don't parse or run backwards
  // rather than folding garbage into the average.
  let earliestSum = 0;
  let latestSum = 0;
  let windowed = 0;
  for (const r of rows) {
    if (!r.delivery_earliest || !r.delivery_latest || !r.created_at) continue;
    const created = new Date(String(r.created_at)).getTime();
    const earliest = new Date(String(r.delivery_earliest)).getTime();
    const latest = new Date(String(r.delivery_latest)).getTime();
    if (
      !Number.isFinite(created) ||
      !Number.isFinite(earliest) ||
      !Number.isFinite(latest)
    ) {
      continue;
    }
    const eDays = Math.round((earliest - created) / DAY_MS);
    const lDays = Math.round((latest - created) / DAY_MS);
    if (eDays < 0 || lDays < eDays) continue;
    earliestSum += eDays;
    latestSum += lDays;
    windowed += 1;
  }
  let avgPromise: string | null = null;
  if (windowed > 0) {
    const e = Math.round(earliestSum / windowed);
    const l = Math.round(latestSum / windowed);
    avgPromise = e === l ? `${e} days` : `${e}–${l} days`;
  }

  return { count: total, avgShippingCents, fallbackSharePct, lowConfidenceSharePct, avgPromise };
}

export async function loadShippingSummary(shopId: string): Promise<ShippingSummary> {
  const [origin, carrierService, coverage, quotes30d] = await Promise.all([
    loadOrigin(shopId),
    loadCarrierService(shopId),
    loadCoverage(shopId),
    loadQuotes30d(shopId),
  ]);
  return {
    origin,
    carrierService,
    coverage,
    rateCard: buildRateCard(origin?.country ?? "US"),
    quotes30d,
  };
}
