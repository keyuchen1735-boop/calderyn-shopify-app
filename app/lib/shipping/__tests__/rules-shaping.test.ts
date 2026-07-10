import { describe, it, expect } from "vitest";
import { DEFAULT_SHIP_RULES, toMerchantShipRules } from "../rules.server";
import { createQuoteEngine } from "../engine.impl.server";
import { QuoteCache } from "../cache";
import type { RateQuoteSource } from "~/lib/ship-cost/adapters/rate-quote";
import type { ShippingQuoteRequest } from "../quote";

describe("toMerchantShipRules", () => {
  it("omits neutral knobs so an untouched shop keeps a rule-free engine cache key", () => {
    expect(toMerchantShipRules({ ...DEFAULT_SHIP_RULES })).toEqual({});
  });

  it("carries configured knobs and converts nothing", () => {
    expect(
      toMerchantShipRules({
        ...DEFAULT_SHIP_RULES,
        markupPct: 10,
        handlingCents: 250,
        freeShipThresholdCents: 5000,
        handlingDays: 2,
      }),
    ).toEqual({ markupPct: 10, handlingCents: 250, freeShipThresholdCents: 5000, handlingDays: 2 });
  });

  it("stretches handling days to the slowest variant, never shrinks below the shop rule", () => {
    expect(toMerchantShipRules({ ...DEFAULT_SHIP_RULES, handlingDays: 2 }, 5).handlingDays).toBe(5);
    expect(toMerchantShipRules({ ...DEFAULT_SHIP_RULES, handlingDays: 4 }, 2).handlingDays).toBe(4);
  });
});

describe("engine handling-days + rules integration", () => {
  const NOW = new Date("2026-07-10T12:00:00Z");
  const source: RateQuoteSource = {
    id: "test:src",
    getRates: async () => ({
      options: [
        {
          carrier: "USPS",
          serviceCode: "Priority",
          serviceName: "Priority",
          amountCents: 800,
          currency: "USD",
          estTransitDays: 2,
          guaranteed: false,
          deliveryDateEstimate: null,
          rateType: "list",
        },
      ],
      fallbackUsed: false,
      latencyMs: 1,
      provider: "easypost",
    }),
  };
  const req: ShippingQuoteRequest = {
    cart: [{ variantId: "V1", quantity: 1, weightOz: 8, lengthIn: 4, widthIn: 4, heightIn: 2 }],
    cartSubtotalCents: 4000,
    origin: { street1: "1 A", city: "Portland", state: "OR", zip: "97201", country: "US" },
    destination: { street1: "2 B", city: "Denver", state: "CO", zip: "80202", country: "US" },
    currency: "USD",
    options: { selection: "cheapest" },
  };

  function engine() {
    return createQuoteEngine({ now: () => NOW, cache: new QuoteCache(), cacheTtlMs: 0 });
  }

  it("rules.handlingDays widens the delivery window beyond the engine default", async () => {
    const base = await engine()(req, source);
    expect(base.options[0].deliveryWindow).toEqual({ earliest: "2026-07-12", latest: "2026-07-13" });

    const slow = await engine()(req, source, { handlingDays: 4 });
    expect(slow.options[0].deliveryWindow).toEqual({ earliest: "2026-07-12", latest: "2026-07-16" });
  });

  it("free-ship threshold zeroes the charge and records provenance", async () => {
    const q = await engine()(req, source, { freeShipThresholdCents: 3500 });
    expect(q.options[0].amountCents).toBe(0);
    expect(q.options[0].appliedRules).toContain("freeship");
    expect(q.options[0].baseAmountCents).toBe(800);
  });

  it("markup + handling fee stack before free-ship and never under a threshold not met", async () => {
    const q = await engine()(req, source, {
      markupPct: 25,
      handlingCents: 100,
      freeShipThresholdCents: 10_000,
    });
    // 800 * 1.25 = 1000, + 100 handling = 1100; threshold (100.00) not met by 40.00 subtotal.
    expect(q.options[0].amountCents).toBe(1100);
  });

  it("applies serviceFilter ENGINE-side, so sources that ignore it (flat rates, default bands) still honor the buyer's choice", async () => {
    // A source that returns everything regardless of req.serviceFilter — like the
    // merchant flat-rate and default-band sources.
    const unfiltered: RateQuoteSource = {
      id: "test:unfiltered",
      getRates: async () => ({
        options: [
          { carrier: "Standard", serviceCode: "Standard", serviceName: "Standard", amountCents: 500, currency: "USD", estTransitDays: 5, guaranteed: false, deliveryDateEstimate: null, rateType: "list" },
          { carrier: "Standard", serviceCode: "Express", serviceName: "Express", amountCents: 1500, currency: "USD", estTransitDays: 2, guaranteed: false, deliveryDateEstimate: null, rateType: "list" },
        ],
        fallbackUsed: false,
        latencyMs: 1,
        provider: "merchant",
      }),
    };
    const q = await engine()(
      { ...req, options: { serviceFilter: ["Express"], selection: "cheapest" } },
      unfiltered,
    );
    expect(q.options).toHaveLength(1);
    expect(q.options[0].service).toBe("Express");
    expect(q.options[0].amountCents).toBe(1500);
  });

  it("keeps a merchant-authored $0 flat rate (free shipping is real config, not a broken rate)", async () => {
    const freeSource: RateQuoteSource = {
      id: "test:free",
      getRates: async () => ({
        options: [
          { carrier: "Standard", serviceCode: "Free", serviceName: "Free shipping", amountCents: 0, currency: "USD", estTransitDays: 6, guaranteed: false, deliveryDateEstimate: null, rateType: "list" },
        ],
        fallbackUsed: false,
        latencyMs: 1,
        provider: "merchant",
      }),
    };
    const q = await engine()(req, freeSource);
    expect(q.fallbackUsed).toBe(false); // NOT degraded to the paid fallback bands
    expect(q.options[0].amountCents).toBe(0);
    expect(q.options[0].serviceName).toBe("Free shipping");
  });

  it("still suppresses a $0 CARRIER rate as non-serviceable", async () => {
    const brokenCarrier: RateQuoteSource = {
      id: "test:broken",
      getRates: async () => ({
        options: [
          { carrier: "USPS", serviceCode: "Ground", serviceName: "Ground", amountCents: 0, currency: "USD", estTransitDays: 5, guaranteed: false, deliveryDateEstimate: null, rateType: "list" },
        ],
        fallbackUsed: false,
        latencyMs: 1,
        provider: "easypost",
      }),
    };
    const q = await engine()(req, brokenCarrier);
    expect(q.fallbackUsed).toBe(true); // degraded — a $0 carrier rate is never presented as free
    expect(q.options.every((o) => o.amountCents > 0)).toBe(true);
  });
});
