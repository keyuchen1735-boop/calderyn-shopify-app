// Tests for quoteCart's per-variant dims/weight wiring (#6.3 shipping seam)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { priceLines } from "~/lib/order/cart.server";
import { getShopOrigin } from "~/lib/commerce/origin.server";
import { getRateSource, resolveRateSource } from "~/lib/commerce/rate-source.server";
import { calculateTax } from "~/lib/commerce/tax.server";
import { getShippingEngine } from "~/lib/shipping/engine.server";
import { cartShipInfo } from "~/lib/shipping/parcel.server";
import { loadShipRules } from "~/lib/shipping/rules.server";
import { ShipRestrictedError } from "~/lib/shipping/errors";

vi.mock("~/lib/order/cart.server", () => ({
  priceLines: vi.fn(),
}));
vi.mock("~/lib/commerce/origin.server", () => ({
  getShopOrigin: vi.fn(),
}));
vi.mock("~/lib/commerce/rate-source.server", () => ({
  getRateSource: vi.fn(),
  resolveRateSource: vi.fn(),
  RateSourceNotConfiguredError: class RateSourceNotConfiguredError extends Error {
    code = "RATE_SOURCE_NOT_CONFIGURED" as const;
  },
}));
vi.mock("~/lib/commerce/tax.server", () => ({
  calculateTax: vi.fn(),
}));
vi.mock("~/lib/shipping/engine.server", () => ({
  getShippingEngine: vi.fn(),
}));
vi.mock("~/lib/shipping/parcel.server", () => ({
  cartShipInfo: vi.fn(),
}));
// Mock only the DB read; toMerchantShipRules is pure and stays real so the tests
// exercise the true rules-shaping logic.
vi.mock("~/lib/shipping/rules.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, loadShipRules: vi.fn() };
});

const mockPriceLines = vi.mocked(priceLines);
const mockGetShopOrigin = vi.mocked(getShopOrigin);
const mockGetRateSource = vi.mocked(getRateSource);
const mockResolveRateSource = vi.mocked(resolveRateSource);
const mockCalculateTax = vi.mocked(calculateTax);
const mockGetShippingEngine = vi.mocked(getShippingEngine);
const mockCartShipInfo = vi.mocked(cartShipInfo);
const mockLoadShipRules = vi.mocked(loadShipRules);

const NEUTRAL_RULES = {
  markupPct: 0,
  handlingCents: 0,
  freeShipThresholdCents: null,
  handlingDays: 1,
  pickupEnabled: false,
  pickupNote: null,
};

const FAKE_ORIGIN = {
  street1: "1 Main St",
  city: "Portland",
  state: "OR",
  zip: "97201",
  country: "US",
} as const;

const FAKE_DESTINATION = {
  street1: "99 Elm St",
  city: "Seattle",
  state: "WA",
  zip: "98101",
  country: "US",
} as const;

const FAKE_RATE_SOURCE = { type: "easypost" as const, apiKey: "test-key" };

const FAKE_QUOTE_RESULT = {
  options: [
    {
      service: "USPS_PRIORITY",
      serviceName: "Priority Mail",
      carrier: "USPS",
      amountCents: 799,
      baseAmountCents: 799,
      appliedRules: [],
      currency: "USD",
      deliveryWindow: { earliest: "2026-07-03", latest: "2026-07-05" },
      guaranteed: false,
      pickupAvailable: false,
    },
  ],
  currency: "USD",
  source: "carrier" as const,
  fallbackUsed: false,
  lowConfidence: false,
  requestHash: "abc123",
};

function makePricedLines(variantId = "var_1") {
  return {
    lines: [{ variantId, quantity: 2, unitCents: 1000, totalCents: 2000 }],
    subtotalCents: 2000,
    currency: "USD",
  };
}

function shipInfo(over: {
  blocked?: string[];
  maxHandlingDays?: number;
  parcels?: Record<string, { weightOz: number; lengthIn: number; widthIn: number; heightIn: number }>;
} = {}) {
  return {
    blocked: over.blocked ?? [],
    maxHandlingDays: over.maxHandlingDays ?? 0,
    parcelByVariant: new Map(Object.entries(over.parcels ?? {})),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockGetShopOrigin.mockResolvedValue(FAKE_ORIGIN);
  mockGetRateSource.mockResolvedValue(FAKE_RATE_SOURCE as never);
  mockResolveRateSource.mockResolvedValue({ source: FAKE_RATE_SOURCE, kind: "carrier" } as never);
  mockCalculateTax.mockResolvedValue(100);
  mockCartShipInfo.mockResolvedValue(shipInfo()); // default: nothing restricted, no ship data
  mockLoadShipRules.mockResolvedValue(NEUTRAL_RULES);
});

describe("quoteCart — ship-data wiring", () => {
  it("populates weightOz/lengthIn/widthIn/heightIn from the batched ship-data read", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_abc") as never);
    mockCartShipInfo.mockResolvedValue(
      shipInfo({ parcels: { var_abc: { weightOz: 12, lengthIn: 10, widthIn: 8, heightIn: 4 } } }),
    );

    // Capture the request the engine receives
    let capturedReq: unknown;
    const fakeEngine = vi.fn(async (req: unknown) => {
      capturedReq = req;
      return FAKE_QUOTE_RESULT;
    });
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCart } = await import("~/lib/commerce/quote.server");
    await quoteCart("shop_1", [{ variantId: "var_abc", quantity: 2 }], FAKE_DESTINATION);

    expect(cartShipInfo).toHaveBeenCalledWith(["var_abc"], "US");
    const req = capturedReq as { cart: { variantId: string; quantity: number; weightOz?: number; lengthIn?: number; widthIn?: number; heightIn?: number }[] };
    expect(req.cart[0].weightOz).toBe(12);
    expect(req.cart[0].lengthIn).toBe(10);
    expect(req.cart[0].widthIn).toBe(8);
    expect(req.cart[0].heightIn).toBe(4);
  });

  it("falls back to bare { variantId, quantity } when the variant has no ship data, and quoting still succeeds", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_xyz") as never);
    // var_xyz absent from parcelByVariant → bare line → engine low-confidence path.

    let capturedReq: unknown;
    const fakeEngine = vi.fn(async (req: unknown) => {
      capturedReq = req;
      return { ...FAKE_QUOTE_RESULT, lowConfidence: true };
    });
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCart } = await import("~/lib/commerce/quote.server");
    const result = await quoteCart("shop_1", [{ variantId: "var_xyz", quantity: 1 }], FAKE_DESTINATION);

    // Should not throw; result is a valid CartQuote
    expect(result.shippingCents).toBe(799);
    expect(result.lowConfidence).toBe(true);

    const req = capturedReq as { cart: { variantId: string; quantity: number; weightOz?: number; lengthIn?: number }[] };
    // Bare line — no dims attached (quantity from priced.lines, not the raw input)
    expect(req.cart[0].variantId).toBe("var_xyz");
    expect(req.cart[0].quantity).toBe(2); // priced.lines mock returns quantity: 2
    expect(req.cart[0].weightOz).toBeUndefined();
    expect(req.cart[0].lengthIn).toBeUndefined();
  });

  it("throws ShipRestrictedError (no rate call) when a line cannot ship to the destination", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_ca") as never);
    mockCartShipInfo.mockResolvedValue(shipInfo({ blocked: ["var_ca"] }));
    const fakeEngine = vi.fn(async () => FAKE_QUOTE_RESULT);
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCart } = await import("~/lib/commerce/quote.server");
    const err = await quoteCart("shop_1", [{ variantId: "var_ca", quantity: 1 }], FAKE_DESTINATION).catch((e) => e);

    expect(err).toBeInstanceOf(ShipRestrictedError);
    expect(err.destinationCountry).toBe("US");
    expect(err.variantIds).toEqual(["var_ca"]);
    expect(mockCartShipInfo).toHaveBeenCalledWith(["var_ca"], "US");
    expect(fakeEngine).not.toHaveBeenCalled(); // fail fast — no wasted rate call
  });
});

function fakeOption(over: Partial<(typeof FAKE_QUOTE_RESULT)["options"][0]>) {
  return { ...FAKE_QUOTE_RESULT.options[0], ...over };
}

describe("quoteCart — merchant rules + chosen service", () => {
  it("passes shaped merchant rules to the engine, handling days stretched by the slowest variant", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_r") as never);
    mockLoadShipRules.mockResolvedValue({
      ...NEUTRAL_RULES,
      markupPct: 10,
      freeShipThresholdCents: 5000,
      handlingDays: 2,
    });
    mockCartShipInfo.mockResolvedValue(shipInfo({ maxHandlingDays: 5 }));

    let capturedRules: unknown;
    const fakeEngine = vi.fn(async (_req: unknown, _src: unknown, rules: unknown) => {
      capturedRules = rules;
      return FAKE_QUOTE_RESULT;
    });
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCart } = await import("~/lib/commerce/quote.server");
    await quoteCart("shop_1", [{ variantId: "var_r", quantity: 1 }], FAKE_DESTINATION);

    expect(capturedRules).toEqual({ markupPct: 10, freeShipThresholdCents: 5000, handlingDays: 5 });
  });

  it("prices the buyer's chosen carrier-qualified option via serviceFilter and reports its name", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_s") as never);

    let capturedReq: { options?: { serviceFilter?: string[] } } | undefined;
    const fakeEngine = vi.fn(async (req: unknown) => {
      capturedReq = req as typeof capturedReq;
      return FAKE_QUOTE_RESULT;
    });
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCart } = await import("~/lib/commerce/quote.server");
    const q = await quoteCart("shop_1", [{ variantId: "var_s", quantity: 1 }], FAKE_DESTINATION, {
      shippingService: "USPS::USPS_PRIORITY",
    });

    expect(capturedReq?.options?.serviceFilter).toEqual(["USPS_PRIORITY"]);
    expect(q.shippingService).toBe("Priority Mail");
  });

  it("throws ShippingOptionUnavailableError when the chosen service comes back as something else", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_gone") as never);
    // Engine degraded to fallback: the filtered service vanished, options are the fallback table.
    const fakeEngine = vi.fn(async () => ({
      ...FAKE_QUOTE_RESULT,
      options: [fakeOption({ service: "Economy", serviceName: "Economy", carrier: "Standard" })],
      fallbackUsed: true,
    }));
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCart } = await import("~/lib/commerce/quote.server");
    const { ShippingOptionUnavailableError } = await import("~/lib/shipping/errors");
    const err = await quoteCart("shop_1", [{ variantId: "var_gone", quantity: 1 }], FAKE_DESTINATION, {
      shippingService: "USPS::USPS_PRIORITY",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ShippingOptionUnavailableError);
    expect(err.service).toBe("USPS::USPS_PRIORITY");
  });

  it("rejects a same-code option from a DIFFERENT carrier (no silent carrier swap)", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_swap") as never);
    // Buyer chose UPS::Express; the cheapest code-match came back from DHL.
    const fakeEngine = vi.fn(async () => ({
      ...FAKE_QUOTE_RESULT,
      options: [fakeOption({ service: "Express", serviceName: "Express", carrier: "DHL", amountCents: 1400 })],
    }));
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCart } = await import("~/lib/commerce/quote.server");
    const { ShippingOptionUnavailableError } = await import("~/lib/shipping/errors");
    const err = await quoteCart("shop_1", [{ variantId: "var_swap", quantity: 1 }], FAKE_DESTINATION, {
      shippingService: "UPS::Express",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ShippingOptionUnavailableError);
  });
});

describe("quoteCartOptions — buyer choice shortlist", () => {
  it("dedupes by carrier+service keeping the CHEAPEST, caps at 5, and always keeps the fastest", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_o") as never);

    const window = (earliest: string) => ({ earliest, latest: earliest });
    const fakeEngine = vi.fn(async () => ({
      ...FAKE_QUOTE_RESULT,
      options: [
        fakeOption({ service: "a", serviceName: "A", carrier: "X", amountCents: 105, deliveryWindow: window("2026-07-20") }), // pricier dup FIRST
        fakeOption({ service: "a", serviceName: "A", carrier: "X", amountCents: 100, deliveryWindow: window("2026-07-20") }),
        fakeOption({ service: "b", serviceName: "B", carrier: "X", amountCents: 200, deliveryWindow: window("2026-07-19") }),
        fakeOption({ service: "c", serviceName: "C", carrier: "X", amountCents: 300, deliveryWindow: window("2026-07-18") }),
        fakeOption({ service: "d", serviceName: "D", carrier: "X", amountCents: 400, deliveryWindow: window("2026-07-17") }),
        fakeOption({ service: "e", serviceName: "E", carrier: "X", amountCents: 500, deliveryWindow: window("2026-07-16") }),
        fakeOption({ service: "f", serviceName: "Fastest", carrier: "X", amountCents: 900, deliveryWindow: window("2026-07-12") }),
      ],
    }));
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCartOptions } = await import("~/lib/commerce/quote.server");
    const { options } = await quoteCartOptions("shop_1", [{ variantId: "var_o", quantity: 1 }], FAKE_DESTINATION);

    expect(options).toHaveLength(5);
    expect(options[0].service).toBe("X::a");
    expect(options[0].amountCents).toBe(100); // the CHEAPEST duplicate wins the dedupe
    // The fastest option displaced the most expensive shortlist slot.
    expect(options.some((o) => o.service === "X::f")).toBe(true);
    expect(options.some((o) => o.service === "X::e")).toBe(false);
  });

  it("keeps same-code options from different carriers distinct", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_cc") as never);
    const fakeEngine = vi.fn(async () => ({
      ...FAKE_QUOTE_RESULT,
      options: [
        fakeOption({ service: "Express", serviceName: "Express", carrier: "DHL", amountCents: 1400 }),
        fakeOption({ service: "Express", serviceName: "Express", carrier: "UPS", amountCents: 2200 }),
      ],
    }));
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCartOptions } = await import("~/lib/commerce/quote.server");
    const { options } = await quoteCartOptions("shop_1", [{ variantId: "var_cc", quantity: 1 }], FAKE_DESTINATION);
    expect(options.map((o) => o.service).sort()).toEqual(["DHL::Express", "UPS::Express"]);
  });

  it("labels options with carrier + service when the carrier adds signal", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_l") as never);
    const fakeEngine = vi.fn(async () => ({
      ...FAKE_QUOTE_RESULT,
      options: [
        fakeOption({ service: "p", serviceName: "Priority", carrier: "USPS" }),
        fakeOption({ service: "std", serviceName: "Economy", carrier: "Standard", amountCents: 900 }),
      ],
    }));
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCartOptions } = await import("~/lib/commerce/quote.server");
    const { options } = await quoteCartOptions("shop_1", [{ variantId: "var_l", quantity: 1 }], FAKE_DESTINATION);
    expect(options[0].label).toBe("USPS Priority");
    expect(options[1].label).toBe("Economy"); // "Standard" carrier is a placeholder, not signal
  });
});

describe("local pickup", () => {
  const PICKUP_RULES = { ...NEUTRAL_RULES, pickupEnabled: true, pickupNote: "Side entrance, Mon to Sat" };

  it("quoteCartOptions appends the pickup option after the carrier shortlist when enabled", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_p") as never);
    mockLoadShipRules.mockResolvedValue(PICKUP_RULES);
    const fakeEngine = vi.fn(async () => FAKE_QUOTE_RESULT);
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCartOptions } = await import("~/lib/commerce/quote.server");
    const { options } = await quoteCartOptions("shop_1", [{ variantId: "var_p", quantity: 1 }], FAKE_DESTINATION);

    const pickup = options[options.length - 1];
    expect(pickup.service).toBe("PICKUP::PICKUP");
    expect(pickup.label).toBe("Pick up in Portland"); // origin city, not the buyer's
    expect(pickup.amountCents).toBe(0);
    expect(pickup.note).toBe("Side entrance, Mon to Sat");
    // Ready date: a single calendar date (earliest === latest), today + handling window.
    expect(pickup.deliveryEarliest).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pickup.deliveryLatest).toBe(pickup.deliveryEarliest);
    // The carrier options are untouched ahead of it.
    expect(options[0].service).toBe("USPS::USPS_PRIORITY");
  });

  it("quoteCartOptions offers pickup ALONE when the cart is destination-restricted (no dead-end)", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_pb") as never);
    mockLoadShipRules.mockResolvedValue(PICKUP_RULES);
    mockCartShipInfo.mockResolvedValue(shipInfo({ blocked: ["var_pb"] }));
    const fakeEngine = vi.fn(async () => FAKE_QUOTE_RESULT);
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCartOptions } = await import("~/lib/commerce/quote.server");
    const { options } = await quoteCartOptions("shop_1", [{ variantId: "var_pb", quantity: 1 }], FAKE_DESTINATION);

    expect(options).toHaveLength(1);
    expect(options[0].service).toBe("PICKUP::PICKUP");
    expect(fakeEngine).not.toHaveBeenCalled(); // shipping can never fulfill this cart
  });

  it("quoteCartOptions still throws ShipRestrictedError for a restricted cart when pickup is off", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_nb") as never);
    mockCartShipInfo.mockResolvedValue(shipInfo({ blocked: ["var_nb"] }));
    const fakeEngine = vi.fn(async () => FAKE_QUOTE_RESULT);
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCartOptions } = await import("~/lib/commerce/quote.server");
    const err = await quoteCartOptions("shop_1", [{ variantId: "var_nb", quantity: 1 }], FAKE_DESTINATION).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ShipRestrictedError);
  });

  it("quoteCartOptions offers pickup ALONE when the engine has no rates for the destination", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_pe") as never);
    mockLoadShipRules.mockResolvedValue(PICKUP_RULES);
    const fakeEngine = vi.fn(async () => ({ ...FAKE_QUOTE_RESULT, options: [] }));
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCartOptions } = await import("~/lib/commerce/quote.server");
    const { options } = await quoteCartOptions("shop_1", [{ variantId: "var_pe", quantity: 1 }], FAKE_DESTINATION);

    expect(options).toHaveLength(1);
    expect(options[0].service).toBe("PICKUP::PICKUP");
  });

  it("quoteCartOptions offers no pickup option when disabled", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_np") as never);
    const fakeEngine = vi.fn(async () => FAKE_QUOTE_RESULT);
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCartOptions } = await import("~/lib/commerce/quote.server");
    const { options } = await quoteCartOptions("shop_1", [{ variantId: "var_np", quantity: 1 }], FAKE_DESTINATION);
    expect(options.some((o) => o.service === "PICKUP::PICKUP")).toBe(false);
  });

  it("quoteCart prices the pickup token WITHOUT the rate engine: $0 shipping, tax at the ORIGIN", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_pk") as never);
    mockLoadShipRules.mockResolvedValue(PICKUP_RULES);
    const fakeEngine = vi.fn(async () => FAKE_QUOTE_RESULT);
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCart } = await import("~/lib/commerce/quote.server");
    const q = await quoteCart("shop_1", [{ variantId: "var_pk", quantity: 1 }], FAKE_DESTINATION, {
      shippingService: "PICKUP::PICKUP",
    });

    expect(fakeEngine).not.toHaveBeenCalled(); // pickup never reaches the rate engine
    // Pickup never resolves a rate source either — a broken carrier credential
    // (connect() throws) must not be able to fail a pickup checkout.
    expect(mockGetRateSource).not.toHaveBeenCalled();
    expect(q.shippingCents).toBe(0);
    expect(q.shippingService).toBe("Store pickup");
    expect(q.totalCents).toBe(2000 + 100); // subtotal + mocked tax, no shipping
    expect(q.lowConfidence).toBe(false);
    expect(q.fallbackUsed).toBe(false);
    expect(q.deliveryLatest).toBe(q.deliveryEarliest);
    // Tax is computed where the goods change hands: the store, not the buyer's address.
    expect(mockCalculateTax).toHaveBeenCalledWith(
      expect.objectContaining({ shippingCents: 0, destination: FAKE_ORIGIN }),
    );
  });

  it("quoteCart skips the destination-restriction gate for pickup (nothing ships)", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_blocked") as never);
    mockLoadShipRules.mockResolvedValue(PICKUP_RULES);
    mockCartShipInfo.mockResolvedValue(shipInfo({ blocked: ["var_blocked"] }));
    const fakeEngine = vi.fn(async () => FAKE_QUOTE_RESULT);
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCart } = await import("~/lib/commerce/quote.server");
    const q = await quoteCart("shop_1", [{ variantId: "var_blocked", quantity: 1 }], FAKE_DESTINATION, {
      shippingService: "PICKUP::PICKUP",
    });
    expect(q.shippingService).toBe("Store pickup");
  });

  it("quoteCart rejects a pickup token when the shop doesn't offer pickup", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_off") as never);
    const fakeEngine = vi.fn(async () => FAKE_QUOTE_RESULT);
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { quoteCart } = await import("~/lib/commerce/quote.server");
    const { ShippingOptionUnavailableError } = await import("~/lib/shipping/errors");
    const err = await quoteCart("shop_1", [{ variantId: "var_off", quantity: 1 }], FAKE_DESTINATION, {
      shippingService: "PICKUP::PICKUP",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ShippingOptionUnavailableError);
    expect(fakeEngine).not.toHaveBeenCalled();
  });
});

describe("estimateShipping — ship-data wiring", () => {
  it("populates dims on cart lines from the batched ship-data read", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_est") as never);
    mockCartShipInfo.mockResolvedValue(
      shipInfo({ parcels: { var_est: { weightOz: 5, lengthIn: 6, widthIn: 4, heightIn: 2 } } }),
    );

    let capturedReq: unknown;
    const fakeEngine = vi.fn(async (req: unknown) => {
      capturedReq = req;
      return FAKE_QUOTE_RESULT;
    });
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { estimateShipping } = await import("~/lib/commerce/estimate.server");
    await estimateShipping("shop_1", [{ variantId: "var_est", quantity: 1 }], { zip: "98101", country: "US" });

    const req = capturedReq as { cart: { variantId: string; weightOz?: number; lengthIn?: number }[] };
    expect(req.cart[0].weightOz).toBe(5);
    expect(req.cart[0].lengthIn).toBe(6);
  });

  it("falls back to bare line when the variant has no ship data, and estimate still succeeds", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_noship") as never);

    let capturedReq: unknown;
    const fakeEngine = vi.fn(async (req: unknown) => {
      capturedReq = req;
      return FAKE_QUOTE_RESULT;
    });
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { estimateShipping } = await import("~/lib/commerce/estimate.server");
    const result = await estimateShipping("shop_1", [{ variantId: "var_noship", quantity: 1 }], { zip: "98101", country: "US" });

    expect(result.isEstimate).toBe(true);
    expect(result.cheapest.amountCents).toBe(799);

    const req = capturedReq as { cart: { variantId: string; quantity: number; weightOz?: number; lengthIn?: number; widthIn?: number; heightIn?: number }[] };
    // Bare line — no dims attached (engine receives only variantId + quantity)
    expect(req.cart[0].weightOz).toBeUndefined();
    expect(req.cart[0].lengthIn).toBeUndefined();
    expect(req.cart[0].widthIn).toBeUndefined();
    expect(req.cart[0].heightIn).toBeUndefined();
  });

  it("throws ShipRestrictedError (no rate call) when a line cannot ship to the destination", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_ca") as never);
    mockCartShipInfo.mockResolvedValue(shipInfo({ blocked: ["var_ca"] }));
    const fakeEngine = vi.fn(async () => FAKE_QUOTE_RESULT);
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { estimateShipping } = await import("~/lib/commerce/estimate.server");
    const err = await estimateShipping("shop_1", [{ variantId: "var_ca", quantity: 1 }], { zip: "98101", country: "US" }).catch((e) => e);

    expect(err).toBeInstanceOf(ShipRestrictedError);
    expect(err.destinationCountry).toBe("US");
    expect(err.variantIds).toEqual(["var_ca"]);
    expect(mockCartShipInfo).toHaveBeenCalledWith(["var_ca"], "US");
    expect(fakeEngine).not.toHaveBeenCalled(); // fail fast — no wasted rate call
  });

  it("refuses to promise from the built-in default bands (zero-setup shop → widget hides)", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_zero") as never);
    mockResolveRateSource.mockResolvedValue({ source: FAKE_RATE_SOURCE, kind: "default" } as never);
    const fakeEngine = vi.fn(async () => FAKE_QUOTE_RESULT);
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    const { estimateShipping } = await import("~/lib/commerce/estimate.server");
    const err = await estimateShipping("shop_1", [{ variantId: "var_zero", quantity: 1 }], { zip: "98101", country: "US" }).catch((e) => e);
    expect((err as { code?: string }).code).toBe("RATE_SOURCE_NOT_CONFIGURED");
    expect(fakeEngine).not.toHaveBeenCalled();
  });
});
