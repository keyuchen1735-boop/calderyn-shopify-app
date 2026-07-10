// CarrierService registration + live rate callback (#6.4) — the MVP gate where a
// real buyer's checkout computes shipping via Calderyn. Server-only (.server.ts).
//
// Two halves:
//   1. registerCarrierService(): authenticated Admin GraphQL carrierServiceCreate,
//      persisted to ship_carrier_service_registration. Idempotent (re-auth / Shopify
//      retries never create a duplicate). Surfaces userErrors (rule 12).
//   2. handleCarrierRateCallback(): the PUBLIC checkout callback. Resolves the shop
//      from the URL token (the authenticator — see the security note below), parses
//      Shopify's rate body, runs the #6.3 shipping engine, and maps the canonical
//      ShippingQuote -> Shopify carrier-rate JSON.
//
// SECURITY — callback authenticity (researched, 2025-07): Shopify does NOT HMAC-sign
// CarrierService callbacks the way it signs webhooks. The CarrierService reference
// documents the callback URL as a plain public POST endpoint with no signature
// header (this DIVERGES from the spec's "HMAC-verified" wording — see the task
// report). So the high-entropy per-shop token in the callback URL path IS the
// authenticator: it is 256-bit random, known only to Shopify (we registered it) and
// carried only over TLS. A callback whose token resolves to no active registration
// is rejected fail-closed with no rates -> no rate oracle, no checkout spoof. The
// token also resolves the shop, so the callback needs no admin session.
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../supabase.server";
import type { AdminGraphqlClient } from "../shopify/inventory.server";
import { buildFallbackOptions } from "../ship-cost/adapters/easypost-rate.server";
import { getRateSource } from "../commerce/rate-source.server";
import type {
  RateQuoteResult,
  RateQuoteSource,
  RateRequest,
} from "../ship-cost/adapters/rate-quote";
import { getShippingEngine } from "./engine.server";
import { loadShipRules, toMerchantShipRules } from "./rules.server";
import type {
  Address,
  MerchantShipRules,
  QuoteShipping,
  ShippingQuote,
  ShippingQuoteLine,
  ShippingQuoteRequest,
} from "./quote";

// ---------------------------------------------------------------------------
// Registration (Admin GraphQL write — mirrors setVariantPrice's error handling)
// ---------------------------------------------------------------------------

/** Carrier-service integration name shown in the merchant's shipping settings. */
export const CARRIER_SERVICE_NAME = "Calderyn";

const CARRIER_SERVICE_CREATE = /* GraphQL */ `
  mutation CalderynCarrierServiceCreate($input: DeliveryCarrierServiceCreateInput!) {
    carrierServiceCreate(input: $input) {
      carrierService {
        id
        name
        callbackUrl
        active
        supportsServiceDiscovery
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface CarrierServiceRegistration {
  shopId: string;
  carrierServiceGid: string;
  callbackUrl: string;
  active: boolean;
}

/** Public callback URL for a shop's token. Path-style so the token is a route param. */
export function buildCallbackUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/carrier-service/rates/${token}`;
}

/** 256-bit URL-safe (hex) secret. The callback authenticator + shop resolver. */
export function generateCallbackToken(): string {
  return randomBytes(32).toString("hex");
}

interface ExistingRegistrationRow {
  carrier_service_gid: string | null;
  callback_token: string | null;
  callback_url: string | null;
  active: boolean | null;
}

/**
 * Register (or reuse) the shop's CarrierService via the authenticated Admin client,
 * persisting the result. Idempotent: an already-active row is returned untouched so
 * re-auth / retries never create a duplicate carrier service; an inactive row (e.g.
 * after reinstall, where Shopify dropped the service) is re-created with the SAME
 * token so the callback URL stays stable. Throws on transport errors or userErrors
 * (rule 12 — a failed registration must never read as success). Requires the
 * write_shipping scope and a qualifying store plan; callers run this best-effort.
 */
export async function registerCarrierService(
  admin: AdminGraphqlClient,
  opts: { shopId: string; baseUrl: string },
  deps: { sb?: SupabaseClient; generateToken?: () => string } = {},
): Promise<CarrierServiceRegistration> {
  const sb = deps.sb ?? getSupabase();
  const generateToken = deps.generateToken ?? generateCallbackToken;

  const existing = await sb
    .from("ship_carrier_service_registration")
    .select("carrier_service_gid, callback_token, callback_url, active")
    .eq("shop_id", opts.shopId)
    .maybeSingle();
  if (existing.error) throw existing.error;
  const row = existing.data as ExistingRegistrationRow | null;

  if (row?.active === true && row.carrier_service_gid && row.callback_url) {
    return {
      shopId: opts.shopId,
      carrierServiceGid: row.carrier_service_gid,
      callbackUrl: row.callback_url,
      active: true,
    };
  }

  const token = row?.callback_token ?? generateToken();
  const callbackUrl = buildCallbackUrl(opts.baseUrl, token);

  const response = await admin.graphql(CARRIER_SERVICE_CREATE, {
    variables: {
      input: {
        name: CARRIER_SERVICE_NAME,
        callbackUrl,
        supportsServiceDiscovery: true,
        active: true,
      },
    },
  });
  const body = (await response.json()) as {
    data?: {
      carrierServiceCreate?: {
        carrierService?: { id: string; callbackUrl: string; active: boolean } | null;
        userErrors?: Array<{ field?: string[] | null; message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  const payload = body.data?.carrierServiceCreate;
  if (payload?.userErrors?.length) {
    throw new Error(
      `carrierServiceCreate userErrors: ${payload.userErrors.map((e) => e.message).join("; ")}`,
    );
  }
  const created = payload?.carrierService;
  if (!created?.id) throw new Error("carrierServiceCreate returned no carrierService");

  const upsert = await sb.from("ship_carrier_service_registration").upsert(
    {
      shop_id: opts.shopId,
      carrier_service_gid: created.id,
      callback_token: token,
      callback_url: callbackUrl,
      active: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "shop_id" },
  );
  if (upsert.error) throw upsert.error;

  return { shopId: opts.shopId, carrierServiceGid: created.id, callbackUrl, active: true };
}

/** Soft-deactivate a shop's registration (called on app/uninstalled). Idempotent. */
export async function deactivateCarrierService(
  shopId: string,
  sb: SupabaseClient = getSupabase(),
): Promise<void> {
  const { error } = await sb
    .from("ship_carrier_service_registration")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Callback authenticity — resolve shop from the URL token (fail closed)
// ---------------------------------------------------------------------------

/**
 * Resolve the shop for a callback token, or null to REJECT (fail closed). Null on:
 * unknown token, an inactive registration, or a DB error — never leak rates to an
 * unauthenticated caller. The token is 256-bit random, so an indexed equality
 * lookup is not a practical timing oracle.
 */
export async function resolveCarrierShopByToken(
  token: string,
  sb: SupabaseClient = getSupabase(),
): Promise<{ shopId: string } | null> {
  if (!token) return null;
  const { data, error } = await sb
    .from("ship_carrier_service_registration")
    .select("shop_id, active")
    .eq("callback_token", token)
    .maybeSingle();
  if (error) {
    console.error("[carrier-service] token lookup failed", error);
    return null; // fail closed
  }
  if (!data || (data as { active?: boolean }).active !== true) return null;
  return { shopId: (data as { shop_id: string }).shop_id };
}

// ---------------------------------------------------------------------------
// Shopify rate body -> ShippingQuoteRequest (strict parse; null = reject)
// ---------------------------------------------------------------------------

interface CarrierAddress {
  country?: string | null;
  postal_code?: string | null;
  province?: string | null;
  city?: string | null;
  name?: string | null;
  address1?: string | null;
  address2?: string | null;
  company_name?: string | null;
  phone?: string | null;
}

interface CarrierItem {
  name?: string | null;
  quantity?: number | null;
  grams?: number | null;
  price?: number | null;
  variant_id?: number | string | null;
  requires_shipping?: boolean | null;
}

export interface ParsedCarrierRate {
  origin: CarrierAddress;
  destination: CarrierAddress;
  items: CarrierItem[];
  currency: string;
  subtotalCents: number | null;
}

const GRAMS_PER_OZ = 28.349523125;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Strict parse of Shopify's `{ rate: { origin, destination, items, currency, ... } }`
 * callback body. Returns null on any shape violation so a malformed/forged body is
 * never quoted (the route degrades a null to an empty rate set rather than blocking
 * checkout). Money fields (item price, order_totals) are integer SUBUNITS (cents).
 */
export function parseCarrierRateRequest(raw: unknown): ParsedCarrierRate | null {
  if (!isObj(raw)) return null;
  const rate = raw.rate;
  if (!isObj(rate)) return null;
  const { origin, destination, items } = rate;
  if (!isObj(origin) || !isObj(destination) || !Array.isArray(items)) return null;

  const currency =
    typeof rate.currency === "string" && rate.currency.trim() ? rate.currency.trim() : "USD";

  let subtotalCents: number | null = null;
  const totals = rate.order_totals;
  if (isObj(totals)) {
    const n = Number(totals.subtotal_price);
    if (Number.isFinite(n)) subtotalCents = Math.round(n);
  }

  return {
    origin: origin as CarrierAddress,
    destination: destination as CarrierAddress,
    items: items as CarrierItem[],
    currency,
    subtotalCents,
  };
}

function toAddress(a: CarrierAddress): Address {
  return {
    name: a.name ?? undefined,
    company: a.company_name ?? undefined,
    street1: a.address1 ?? "",
    street2: undefined,
    city: a.city ?? "",
    state: a.province ?? "",
    zip: a.postal_code ?? "",
    country: a.country ?? "US",
    phone: a.phone ?? undefined,
  };
}

function sumItemSubtotalCents(items: CarrierItem[]): number {
  return items.reduce((acc, it) => {
    const price = typeof it.price === "number" ? it.price : 0;
    const qty = typeof it.quantity === "number" && it.quantity > 0 ? it.quantity : 1;
    return acc + price * qty;
  }, 0);
}

/** Map a parsed callback body to the engine's canonical request. weightOz is
 *  per-unit (the engine multiplies by quantity during parcel assembly). */
export function toShippingQuoteRequest(parsed: ParsedCarrierRate): ShippingQuoteRequest {
  const cart: ShippingQuoteLine[] = parsed.items
    .filter((it) => it.requires_shipping !== false)
    .map((it) => {
      const line: ShippingQuoteLine = {
        variantId: it.variant_id != null ? String(it.variant_id) : "",
        quantity: typeof it.quantity === "number" && it.quantity > 0 ? it.quantity : 1,
      };
      if (typeof it.grams === "number" && it.grams > 0) line.weightOz = it.grams / GRAMS_PER_OZ;
      return line;
    });
  return {
    cart,
    cartSubtotalCents: parsed.subtotalCents ?? sumItemSubtotalCents(parsed.items),
    origin: toAddress(parsed.origin),
    destination: toAddress(parsed.destination),
    currency: parsed.currency,
  };
}

// ---------------------------------------------------------------------------
// ShippingQuote -> Shopify carrier-rate JSON
// ---------------------------------------------------------------------------

export interface ShopifyCarrierRate {
  service_name: string;
  service_code: string;
  description: string;
  currency: string;
  // Shopify requires the price in SUBUNITS (e.g. 500 == $5.00). The engine's
  // amountCents already uses the same x100 convention for every currency, so it
  // maps across 1:1 — no per-currency special-casing.
  // TODO: M4 — zero-decimal currencies (e.g. JPY) need revisiting post-USD pilot.
  total_price: number;
  min_delivery_date?: string;
  max_delivery_date?: string;
}

/** Engine emits a YYYY-MM-DD date; Shopify wants a datetime. Emit UTC midnight in
 *  Shopify's documented "YYYY-MM-DD HH:MM:SS +0000" form; pass through if already
 *  carrying a time component. */
export function toShopifyCarrierDate(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date} 00:00:00 +0000` : date;
}

export function mapQuoteToCarrierRates(quote: ShippingQuote): ShopifyCarrierRate[] {
  return quote.options.map((o) => {
    const description =
      o.carrier && o.carrier !== o.serviceName ? `${o.carrier} ${o.serviceName}` : o.serviceName;
    const rate: ShopifyCarrierRate = {
      service_name: o.serviceName,
      service_code: o.service,
      description,
      currency: o.currency,
      total_price: o.amountCents,
    };
    if (o.deliveryWindow) {
      rate.min_delivery_date = toShopifyCarrierDate(o.deliveryWindow.earliest);
      rate.max_delivery_date = toShopifyCarrierDate(o.deliveryWindow.latest);
    }
    return rate;
  });
}

// ---------------------------------------------------------------------------
// Orchestrator (what the public route calls)
// ---------------------------------------------------------------------------

/** A rate source that always returns the static fallback table — used when the shop
 *  has no carrier credential, or its credential is structurally broken, so checkout
 *  still receives rates (no rate = blocked checkout; the fallback is load-bearing). */
const fallbackRateSource: RateQuoteSource = {
  async getRates(req: RateRequest): Promise<RateQuoteResult> {
    return {
      options: buildFallbackOptions(req),
      fallbackUsed: true,
      latencyMs: 0,
      provider: "easypost",
    };
  },
};

async function defaultConnectRateSource(shopId: string): Promise<RateQuoteSource> {
  // Same resolution chain as native checkout (carrier → merchant flat rates → default
  // bands) so a dual-run Shopify checkout quotes the SAME prices as the native one —
  // a merchant's flat rates must not silently apply on only one surface. A broken
  // credential still THROWS and degrades to the fallback source (caught upstream).
  return getRateSource(shopId);
}

async function defaultLoadRules(shopId: string): Promise<MerchantShipRules | undefined> {
  // ponytail: Shopify's rate body carries SHOPIFY variant ids, not variant_dim UUIDs,
  // so the per-variant handling_days fold the native path applies cannot run here —
  // shop-level rules only. Dual-run delivery windows may under-promise for
  // slow-handling items until an id-mapping lands.
  return toMerchantShipRules(await loadShipRules(shopId));
}

export interface CarrierCallbackDeps {
  resolveShop?: (token: string) => Promise<{ shopId: string } | null>;
  connectRateSource?: (shopId: string) => Promise<RateQuoteSource>;
  loadRules?: (shopId: string) => Promise<MerchantShipRules | undefined>;
  engine?: QuoteShipping;
}

export interface CarrierCallbackResult {
  status: number;
  body: string;
}

const EMPTY_RATES = JSON.stringify({ rates: [] });

/**
 * Handle one CarrierService rate callback. Pure-ish orchestration with injectable
 * deps so it is fully testable without Shopify/Supabase/EasyPost. Contract:
 *   - unknown/blank token            -> 401, {rates:[]}  (fail closed; no rate oracle)
 *   - valid token, unparseable body  -> 200, {rates:[]}  (can't quote; don't block checkout)
 *   - valid token, valid body        -> 200, {rates:[...]} (engine; degrades to fallback)
 * Idempotent: a pure read/quote with no side effects, safe under Shopify retries.
 */
export async function handleCarrierRateCallback(
  token: string,
  rawBody: string,
  deps: CarrierCallbackDeps = {},
): Promise<CarrierCallbackResult> {
  const resolveShop = deps.resolveShop ?? resolveCarrierShopByToken;
  const connectRateSource = deps.connectRateSource ?? defaultConnectRateSource;
  const loadRulesForShop = deps.loadRules ?? defaultLoadRules;
  const engine = deps.engine ?? getShippingEngine();

  const shop = await resolveShop(token);
  if (!shop) return { status: 401, body: EMPTY_RATES };

  let parsed: ParsedCarrierRate | null;
  try {
    parsed = parseCarrierRateRequest(JSON.parse(rawBody));
  } catch {
    parsed = null;
  }
  if (!parsed) return { status: 200, body: EMPTY_RATES };

  const req = toShippingQuoteRequest(parsed);

  let rateSource: RateQuoteSource;
  try {
    rateSource = await connectRateSource(shop.shopId);
  } catch (err) {
    console.error(`[carrier-service] rate source connect failed for shop ${shop.shopId}`, err);
    rateSource = fallbackRateSource;
  }

  // Merchant rules (markup / handling / free-ship / handling window) apply on this
  // surface too, so a dual-run Shopify checkout shows the same prices as the native
  // one. A rules read failure quotes rule-less rather than blocking checkout.
  let rules: MerchantShipRules | undefined;
  try {
    rules = await loadRulesForShop(shop.shopId);
  } catch (err) {
    console.error(`[carrier-service] ship_rules read failed for shop ${shop.shopId}; quoting without rules`, err);
    rules = undefined;
  }

  // The engine is contractually never-throw, but a 500 reaching Shopify here means
  // the buyer sees NO rates -> checkout blocked. Fail closed to a well-formed empty
  // rate set instead (rule 12 — this surface's invariant is "always a valid response").
  let quote: ShippingQuote;
  try {
    quote = await engine(req, rateSource, rules);
  } catch (err) {
    console.error(`[carrier-service] engine threw for shop ${shop.shopId}`, err);
    return { status: 200, body: EMPTY_RATES };
  }
  return { status: 200, body: JSON.stringify({ rates: mapQuoteToCarrierRates(quote) }) };
}
