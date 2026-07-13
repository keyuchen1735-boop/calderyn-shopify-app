import { describe, it, expect, vi } from "vitest";

const ORIGIN = { street1: "1 W St", city: "Denver", state: "CO", zip: "80202", country: "US" };

function mockDeps(engineResult: unknown) {
  vi.doMock("~/lib/order/cart.server", () => ({
    priceLines: async () => ({
      lines: [
        { variantId: "V1", quantity: 1, unitPriceCents: 1000, currency: "usd", titleSnapshot: "Widget" },
      ],
      subtotalCents: 1000,
      currency: "usd",
    }),
  }));
  vi.doMock("./origin.server", () => ({ getShopOrigin: async () => ORIGIN }));
  vi.doMock("./rate-source.server", () => ({
    getRateSource: async () => ({}),
    resolveRateSource: async () => ({ source: {}, kind: "carrier" }),
    RateSourceNotConfiguredError: class RateSourceNotConfiguredError extends Error {
      code = "RATE_SOURCE_NOT_CONFIGURED" as const;
    },
  }));
  vi.doMock("~/lib/shipping/parcel.server", () => ({
    cartShipInfo: async () => ({
      blocked: [],
      maxHandlingDays: 0,
      parcelByVariant: new Map([["V1", { weightOz: 8, lengthIn: 6, widthIn: 4, heightIn: 2 }]]),
    }),
  }));
  vi.doMock("~/lib/shipping/rules.server", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
      ...actual,
      loadShipRules: async () => ({
        markupPct: 0,
        handlingCents: 0,
        freeShipThresholdCents: null,
        handlingDays: 1,
      }),
    };
  });
  vi.doMock("~/lib/shipping/engine.server", () => ({
    getShippingEngine: () => async () => engineResult,
  }));
}

describe("estimateShipping", () => {
  it("returns cheapest + fastest options and a delivery-by date from a coarse zip", async () => {
    vi.resetModules();
    mockDeps({
      options: [
        {
          service: "ground",
          serviceName: "Ground",
          carrier: "USPS",
          amountCents: 500,
          baseAmountCents: 500,
          appliedRules: [],
          currency: "usd",
          deliveryWindow: { earliest: "2026-07-04", latest: "2026-07-07" },
          guaranteed: false,
          pickupAvailable: false,
        },
        {
          service: "express",
          serviceName: "Express",
          carrier: "USPS",
          amountCents: 1500,
          baseAmountCents: 1500,
          appliedRules: [],
          currency: "usd",
          deliveryWindow: { earliest: "2026-07-02", latest: "2026-07-02" },
          guaranteed: true,
          pickupAvailable: false,
        },
      ],
      currency: "usd",
      source: "carrier",
      fallbackUsed: false,
      lowConfidence: true,
      requestHash: "h",
    });
    const { estimateShipping } = await import("./estimate.server");
    const est = await estimateShipping("shop_test", [{ variantId: "V1", quantity: 1 }], { zip: "10001", country: "US" });
    expect(est.cheapest.amountCents).toBe(500);
    expect(est.fastest.deliveryLatest).toBe("2026-07-02");
    expect(est.isEstimate).toBe(true);
  });

  it("marks isEstimate true even when the engine is confident (coarse dest is never exact)", async () => {
    vi.resetModules();
    mockDeps({
      options: [
        {
          service: "g",
          serviceName: "G",
          carrier: "U",
          amountCents: 500,
          baseAmountCents: 500,
          appliedRules: [],
          currency: "usd",
          deliveryWindow: null,
          guaranteed: false,
          pickupAvailable: false,
        },
      ],
      currency: "usd",
      source: "carrier",
      fallbackUsed: false,
      lowConfidence: false,
      requestHash: "h",
    });
    const { estimateShipping } = await import("./estimate.server");
    const est = await estimateShipping("shop_test", [{ variantId: "V1", quantity: 1 }], { zip: "10001", country: "US" });
    expect(est.isEstimate).toBe(true);
  });
});
