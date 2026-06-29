import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildCallbackUrl,
  handleCarrierRateCallback,
  mapQuoteToCarrierRates,
  parseCarrierRateRequest,
  registerCarrierService,
  resolveCarrierShopByToken,
  toShippingQuoteRequest,
  type ShopifyCarrierRate,
} from "../carrier-service.server";
import type { AdminGraphqlClient } from "../../shopify/inventory.server";
import type { ShippingQuote, ShippingQuoteOption } from "../quote";

// --- fakes -----------------------------------------------------------------

function makeAdmin(payload: unknown): AdminGraphqlClient & { graphql: ReturnType<typeof vi.fn> } {
  const graphql = vi.fn(async () => ({ json: async () => payload }) as unknown as Response);
  return { graphql };
}

/** Minimal chainable Supabase fake covering select().eq().maybeSingle() + upsert()/update(). */
function makeSb(opts: {
  existing?: unknown;
  existingError?: unknown;
  upsertError?: unknown;
}): { sb: SupabaseClient; upserts: unknown[] } {
  const upserts: unknown[] = [];
  const sb = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({
                  data: opts.existing ?? null,
                  error: opts.existingError ?? null,
                }),
              };
            },
          };
        },
        upsert(row: unknown) {
          upserts.push(row);
          return Promise.resolve({ error: opts.upsertError ?? null });
        },
      };
    },
  };
  return { sb: sb as unknown as SupabaseClient, upserts };
}

function option(over: Partial<ShippingQuoteOption> = {}): ShippingQuoteOption {
  return {
    service: "Priority",
    serviceName: "Priority",
    carrier: "USPS",
    amountCents: 739,
    baseAmountCents: 739,
    appliedRules: [],
    currency: "USD",
    deliveryWindow: { earliest: "2026-07-02", latest: "2026-07-03" },
    guaranteed: false,
    pickupAvailable: false,
    ...over,
  };
}

function quote(over: Partial<ShippingQuote> = {}): ShippingQuote {
  return {
    options: [option()],
    currency: "USD",
    source: "carrier",
    fallbackUsed: false,
    lowConfidence: false,
    requestHash: "h",
    ...over,
  };
}

const VALID_BODY = JSON.stringify({
  rate: {
    origin: { country: "US", postal_code: "94107", province: "CA", city: "San Francisco", address1: "1 Market St" },
    destination: { country: "US", postal_code: "10001", province: "NY", city: "New York", address1: "5th Ave" },
    items: [{ name: "Widget", quantity: 2, grams: 500, price: 1999, variant_id: 123, requires_shipping: true }],
    currency: "USD",
    order_totals: { subtotal_price: "3998" },
  },
});

// --- registration ----------------------------------------------------------

describe("registerCarrierService", () => {
  const SUCCESS = {
    data: {
      carrierServiceCreate: {
        carrierService: {
          id: "gid://shopify/DeliveryCarrierService/1",
          callbackUrl: "x",
          active: true,
        },
        userErrors: [],
      },
    },
  };

  it("creates the carrier service and persists the registration", async () => {
    const admin = makeAdmin(SUCCESS);
    const { sb, upserts } = makeSb({ existing: null });
    const reg = await registerCarrierService(
      admin,
      { shopId: "shop-1", baseUrl: "https://app.example.com/" },
      { sb, generateToken: () => "tok_abc" },
    );
    expect(admin.graphql).toHaveBeenCalledTimes(1);
    expect(reg.carrierServiceGid).toBe("gid://shopify/DeliveryCarrierService/1");
    expect(reg.callbackUrl).toBe("https://app.example.com/carrier-service/rates/tok_abc");
    expect(upserts[0]).toMatchObject({
      shop_id: "shop-1",
      carrier_service_gid: "gid://shopify/DeliveryCarrierService/1",
      callback_token: "tok_abc",
      active: true,
    });
  });

  it("surfaces userErrors as a throw (rule 12 — failed write must not read as success)", async () => {
    const admin = makeAdmin({
      data: {
        carrierServiceCreate: {
          carrierService: null,
          userErrors: [{ field: ["callbackUrl"], message: "callback url is invalid" }],
        },
      },
    });
    const { sb, upserts } = makeSb({ existing: null });
    await expect(
      registerCarrierService(admin, { shopId: "shop-1", baseUrl: "https://app.example.com" }, { sb }),
    ).rejects.toThrow(/callback url is invalid/);
    expect(upserts).toHaveLength(0); // nothing persisted on failure
  });

  it("is idempotent: an already-active registration is reused without a new mutation", async () => {
    const admin = makeAdmin(SUCCESS);
    const { sb } = makeSb({
      existing: {
        carrier_service_gid: "gid://shopify/DeliveryCarrierService/9",
        callback_token: "old",
        callback_url: "https://app.example.com/carrier-service/rates/old",
        active: true,
      },
    });
    const reg = await registerCarrierService(admin, { shopId: "shop-1", baseUrl: "https://app.example.com" }, { sb });
    expect(admin.graphql).not.toHaveBeenCalled();
    expect(reg.carrierServiceGid).toBe("gid://shopify/DeliveryCarrierService/9");
  });

  it("reuses the existing token when re-registering an inactive row (stable callback URL)", async () => {
    const admin = makeAdmin(SUCCESS);
    const { sb } = makeSb({
      existing: {
        carrier_service_gid: "gid://shopify/DeliveryCarrierService/9",
        callback_token: "old_token",
        callback_url: "https://app.example.com/carrier-service/rates/old_token",
        active: false,
      },
    });
    const gen = vi.fn(() => "new_token");
    const reg = await registerCarrierService(
      admin,
      { shopId: "shop-1", baseUrl: "https://app.example.com" },
      { sb, generateToken: gen },
    );
    expect(admin.graphql).toHaveBeenCalledTimes(1);
    expect(gen).not.toHaveBeenCalled();
    expect(reg.callbackUrl).toContain("/old_token");
  });
});

// --- token resolution (authenticator) --------------------------------------

describe("resolveCarrierShopByToken", () => {
  it("resolves the shop for an active token", async () => {
    const { sb } = makeSb({ existing: { shop_id: "shop-1", active: true } });
    expect(await resolveCarrierShopByToken("tok", sb)).toEqual({ shopId: "shop-1" });
  });

  it("rejects an inactive registration (fail closed)", async () => {
    const { sb } = makeSb({ existing: { shop_id: "shop-1", active: false } });
    expect(await resolveCarrierShopByToken("tok", sb)).toBeNull();
  });

  it("rejects an unknown token", async () => {
    const { sb } = makeSb({ existing: null });
    expect(await resolveCarrierShopByToken("nope", sb)).toBeNull();
  });

  it("rejects (fail closed) on a DB error rather than leaking", async () => {
    const { sb } = makeSb({ existingError: { message: "db down" } });
    expect(await resolveCarrierShopByToken("tok", sb)).toBeNull();
  });

  it("rejects a blank token without a DB round trip", async () => {
    const { sb } = makeSb({ existing: { shop_id: "x", active: true } });
    expect(await resolveCarrierShopByToken("", sb)).toBeNull();
  });
});

// --- body parsing + mapping ------------------------------------------------

describe("parseCarrierRateRequest", () => {
  it("parses a valid body", () => {
    const p = parseCarrierRateRequest(JSON.parse(VALID_BODY));
    expect(p).not.toBeNull();
    expect(p?.currency).toBe("USD");
    expect(p?.subtotalCents).toBe(3998);
    expect(p?.items).toHaveLength(1);
  });

  it("rejects a missing rate envelope", () => {
    expect(parseCarrierRateRequest({})).toBeNull();
    expect(parseCarrierRateRequest(null)).toBeNull();
  });

  it("rejects a body whose items is not an array", () => {
    expect(
      parseCarrierRateRequest({ rate: { origin: {}, destination: {}, items: "nope" } }),
    ).toBeNull();
  });
});

describe("toShippingQuoteRequest", () => {
  it("maps grams to per-unit ounces and drops non-shippable items", () => {
    const parsed = parseCarrierRateRequest(
      JSON.parse(
        JSON.stringify({
          rate: {
            origin: { country: "US", postal_code: "94107", province: "CA", city: "SF", address1: "1 Market" },
            destination: { country: "US", postal_code: "10001", province: "NY", city: "NY", address1: "5th" },
            items: [
              { quantity: 2, grams: 500, price: 1999, variant_id: 1, requires_shipping: true },
              { quantity: 1, grams: 100, price: 500, variant_id: 2, requires_shipping: false },
            ],
            currency: "USD",
          },
        }),
      ),
    )!;
    const req = toShippingQuoteRequest(parsed);
    expect(req.cart).toHaveLength(1); // non-shippable filtered
    expect(req.cart[0].weightOz).toBeCloseTo(500 / 28.349523125, 6);
    expect(req.origin.zip).toBe("94107");
    expect(req.destination.state).toBe("NY");
    // no order_totals -> subtotal summed from items (price * qty, in cents)
    expect(req.cartSubtotalCents).toBe(1999 * 2 + 500 * 1);
  });
});

describe("mapQuoteToCarrierRates", () => {
  it("maps amountCents straight to total_price (subunits) and formats delivery dates", () => {
    const rates = mapQuoteToCarrierRates(quote());
    const r = rates[0] as ShopifyCarrierRate;
    expect(r.total_price).toBe(739); // subunits == amountCents, never a decimal string
    expect(r.service_code).toBe("Priority");
    expect(r.currency).toBe("USD");
    expect(r.description).toBe("USPS Priority");
    expect(r.min_delivery_date).toBe("2026-07-02 00:00:00 +0000");
    expect(r.max_delivery_date).toBe("2026-07-03 00:00:00 +0000");
  });

  it("omits delivery dates when the option has no window", () => {
    const rates = mapQuoteToCarrierRates(quote({ options: [option({ deliveryWindow: null })] }));
    expect(rates[0].min_delivery_date).toBeUndefined();
    expect(rates[0].max_delivery_date).toBeUndefined();
  });

  it("still produces rates from a degraded fallback quote (load-bearing — no rate = no sale)", () => {
    const fb = quote({
      source: "fallback",
      fallbackUsed: true,
      options: [
        option({ service: "Economy", serviceName: "Economy", carrier: "Standard", amountCents: 599, deliveryWindow: null }),
      ],
    });
    const rates = mapQuoteToCarrierRates(fb);
    expect(rates).toHaveLength(1);
    expect(rates[0].total_price).toBe(599);
    expect(rates[0].service_code).toBe("Economy");
  });
});

// --- callback orchestration (security-critical: accept valid, reject unsigned) ---

describe("handleCarrierRateCallback", () => {
  it("accepts a valid token + body and returns mapped rates", async () => {
    const engine = vi.fn(async () => quote());
    const res = await handleCarrierRateCallback("tok", VALID_BODY, {
      resolveShop: async () => ({ shopId: "shop-1" }),
      connectRateSource: async () => ({ getRates: async () => ({ options: [], fallbackUsed: false, latencyMs: 0, provider: "easypost" }) }),
      engine,
    });
    expect(res.status).toBe(200);
    expect(engine).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(res.body) as { rates: ShopifyCarrierRate[] };
    expect(parsed.rates[0].total_price).toBe(739);
  });

  it("REJECTS an unsigned/tampered request (unknown token) fail-closed with no rates", async () => {
    const engine = vi.fn(async () => quote());
    const res = await handleCarrierRateCallback("forged-token", VALID_BODY, {
      resolveShop: async () => null, // token resolves to no active registration
      engine,
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ rates: [] });
    expect(engine).not.toHaveBeenCalled(); // no rate computed for an unauthenticated caller
  });

  it("does not block checkout on an unparseable body (valid token) — returns 200 empty rates", async () => {
    const engine = vi.fn(async () => quote());
    const res = await handleCarrierRateCallback("tok", "{ not json", {
      resolveShop: async () => ({ shopId: "shop-1" }),
      engine,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ rates: [] });
    expect(engine).not.toHaveBeenCalled();
  });

  it("returns a well-formed 200 {rates:[]} when the engine throws — never a 500 to Shopify (M1)", async () => {
    const engine = vi.fn(async () => {
      throw new Error("engine blew up"); // engine is contractually never-throw; defense-in-depth
    });
    const res = await handleCarrierRateCallback("tok", VALID_BODY, {
      resolveShop: async () => ({ shopId: "shop-1" }),
      connectRateSource: async () => ({ getRates: async () => ({ options: [], fallbackUsed: false, latencyMs: 0, provider: "easypost" }) }),
      engine,
    });
    expect(res.status).toBe(200); // a 500 here would block the buyer's checkout
    expect(JSON.parse(res.body)).toEqual({ rates: [] }); // well-formed empty response
    expect(engine).toHaveBeenCalledTimes(1);
  });

  it("still returns rates when the rate source connect throws (degrades to fallback)", async () => {
    // engine receives whatever source we hand it; here it returns a fallback quote.
    const engine = vi.fn(async () => quote({ source: "fallback", fallbackUsed: true }));
    const res = await handleCarrierRateCallback("tok", VALID_BODY, {
      resolveShop: async () => ({ shopId: "shop-1" }),
      connectRateSource: async () => {
        throw new Error("broken credential");
      },
      engine,
    });
    expect(res.status).toBe(200);
    expect(engine).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(res.body) as { rates: ShopifyCarrierRate[] };
    expect(parsed.rates.length).toBeGreaterThan(0);
  });
});

describe("buildCallbackUrl", () => {
  it("trims a trailing slash and appends the token path", () => {
    expect(buildCallbackUrl("https://app.example.com/", "t")).toBe(
      "https://app.example.com/carrier-service/rates/t",
    );
  });
});
