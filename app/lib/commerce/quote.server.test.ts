import { describe, it, expect, vi } from "vitest";

const DEST = { street1: "1 A St", city: "Denver", state: "CO", zip: "80202", country: "US" };

function mockDeps() {
  vi.doMock("~/lib/order/cart.server", () => ({
    priceLines: async () => ({
      lines: [{ variantId: "V1", quantity: 1, unitPriceCents: 1000, currency: "usd", titleSnapshot: "Widget" }],
      subtotalCents: 1000,
      currency: "usd",
    }),
  }));
  vi.doMock("./origin.server", () => ({ getShopOrigin: async () => DEST }));
  vi.doMock("./rate-source.server", () => ({ getRateSource: async () => ({ getRates: async () => ({ options: [], currency: "usd" }) }) }));
  vi.doMock("./tax.server", () => ({ calculateTax: async () => 80 }));
  vi.doMock("~/lib/shipping/parcel.server", () => ({
    buildParcel: async () => ({ weightOz: 8, lengthIn: 6, widthIn: 4, heightIn: 2 }),
    restrictedVariants: async () => [],
  }));
  vi.doMock("~/lib/shipping/engine.server", () => ({
    getShippingEngine: () => async () => ({
      options: [{ service: "ground", serviceName: "Ground", carrier: "USPS", amountCents: 500, baseAmountCents: 500, appliedRules: [], currency: "usd", deliveryWindow: { earliest: "2026-07-02", latest: "2026-07-05" }, guaranteed: false, pickupAvailable: false }],
      currency: "usd", source: "carrier", fallbackUsed: false, lowConfidence: false, requestHash: "h",
    }),
  }));
}

describe("quoteCart", () => {
  it("composes subtotal + cheapest shipping + tax into a total (cents)", async () => {
    vi.resetModules();
    mockDeps();
    const { quoteCart } = await import("./quote.server");
    const q = await quoteCart("shop_test", [{ variantId: "V1", quantity: 1 }], DEST);
    expect(q.subtotalCents).toBe(1000);
    expect(q.shippingCents).toBe(500);
    expect(q.taxCents).toBe(80);
    expect(q.totalCents).toBe(1580);
    expect(q.deliveryLatest).toBe("2026-07-05");
  });

  it("subtotalCentsOverride: tax + total computed on the override, not on live priceLines subtotal", async () => {
    vi.resetModules();
    const taxSpy = vi.fn().mockResolvedValue(80);
    vi.doMock("~/lib/order/cart.server", () => ({
      priceLines: async () => ({
        lines: [{ variantId: "V1", quantity: 1, unitPriceCents: 1000, currency: "usd", titleSnapshot: "Widget" }],
        subtotalCents: 1000,
        currency: "usd",
      }),
    }));
    vi.doMock("./origin.server", () => ({ getShopOrigin: async () => DEST }));
    vi.doMock("./rate-source.server", () => ({ getRateSource: async () => ({}) }));
    vi.doMock("./tax.server", () => ({ calculateTax: taxSpy }));
    vi.doMock("~/lib/shipping/parcel.server", () => ({
      buildParcel: async () => ({ weightOz: 8, lengthIn: 6, widthIn: 4, heightIn: 2 }),
      restrictedVariants: async () => [],
    }));
    vi.doMock("~/lib/shipping/engine.server", () => ({
      getShippingEngine: () => async () => ({
        options: [{ service: "ground", serviceName: "Ground", carrier: "USPS", amountCents: 500, baseAmountCents: 500, appliedRules: [], currency: "usd", deliveryWindow: null, guaranteed: false, pickupAvailable: false }],
        currency: "usd", source: "carrier", fallbackUsed: false, lowConfidence: false, requestHash: "h",
      }),
    }));
    const { quoteCart } = await import("./quote.server");
    const q = await quoteCart("shop_test", [{ variantId: "V1", quantity: 1 }], DEST, { subtotalCentsOverride: 999 });
    // Override wins; live priceLines subtotal (1000) is not used.
    expect(q.subtotalCents).toBe(999);
    // Tax was called with the override, not the live subtotal.
    expect(taxSpy).toHaveBeenCalledWith(expect.objectContaining({ subtotalCents: 999 }));
    // Integer identity: subtotal + shipping + tax === total.
    expect(q.totalCents).toBe(999 + 500 + 80);
  });

  it("propagates fallbackUsed/lowConfidence from the engine (rule 12)", async () => {
    vi.resetModules();
    mockDeps();
    vi.doMock("~/lib/shipping/engine.server", () => ({
      getShippingEngine: () => async () => ({
        options: [{ service: "fb", serviceName: "Fallback", carrier: "flat", amountCents: 999, baseAmountCents: 999, appliedRules: [], currency: "usd", deliveryWindow: null, guaranteed: false, pickupAvailable: false }],
        currency: "usd", source: "fallback", fallbackUsed: true, lowConfidence: true, requestHash: "h",
      }),
    }));
    const { quoteCart } = await import("./quote.server");
    const q = await quoteCart("shop_test", [{ variantId: "V1", quantity: 1 }], DEST);
    expect(q.fallbackUsed).toBe(true);
    expect(q.lowConfidence).toBe(true);
  });
});
