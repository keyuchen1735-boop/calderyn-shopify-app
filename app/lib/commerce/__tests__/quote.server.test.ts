// Tests for quoteCart's per-variant dims/weight wiring (#6.3 shipping seam)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { priceLines } from "~/lib/order/cart.server";
import { getShopOrigin } from "~/lib/commerce/origin.server";
import { getRateSource } from "~/lib/commerce/rate-source.server";
import { calculateTax } from "~/lib/commerce/tax.server";
import { getShippingEngine } from "~/lib/shipping/engine.server";
import { buildParcel } from "~/lib/shipping/parcel.server";

vi.mock("~/lib/order/cart.server", () => ({
  priceLines: vi.fn(),
}));
vi.mock("~/lib/commerce/origin.server", () => ({
  getShopOrigin: vi.fn(),
}));
vi.mock("~/lib/commerce/rate-source.server", () => ({
  getRateSource: vi.fn(),
}));
vi.mock("~/lib/commerce/tax.server", () => ({
  calculateTax: vi.fn(),
}));
vi.mock("~/lib/shipping/engine.server", () => ({
  getShippingEngine: vi.fn(),
}));
vi.mock("~/lib/shipping/parcel.server", () => ({
  buildParcel: vi.fn(),
}));

const mockPriceLines = vi.mocked(priceLines);
const mockGetShopOrigin = vi.mocked(getShopOrigin);
const mockGetRateSource = vi.mocked(getRateSource);
const mockCalculateTax = vi.mocked(calculateTax);
const mockGetShippingEngine = vi.mocked(getShippingEngine);
const mockBuildParcel = vi.mocked(buildParcel);

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

beforeEach(() => {
  vi.resetAllMocks();
  mockGetShopOrigin.mockResolvedValue(FAKE_ORIGIN);
  mockGetRateSource.mockResolvedValue(FAKE_RATE_SOURCE as never);
  mockCalculateTax.mockResolvedValue(100);
});

describe("quoteCart — buildParcel wiring", () => {
  it("populates weightOz/lengthIn/widthIn/heightIn when buildParcel returns dims", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_abc") as never);
    mockBuildParcel.mockResolvedValue({
      weightOz: 12,
      lengthIn: 10,
      widthIn: 8,
      heightIn: 4,
    });

    // Capture the request the engine receives
    let capturedReq: unknown;
    const fakeEngine = vi.fn(async (req: unknown) => {
      capturedReq = req;
      return FAKE_QUOTE_RESULT;
    });
    mockGetShippingEngine.mockReturnValue(fakeEngine as never);

    // Import after mocks are configured
    const { quoteCart } = await import("~/lib/commerce/quote.server");
    await quoteCart("shop_1", [{ variantId: "var_abc", quantity: 2 }], FAKE_DESTINATION);

    expect(buildParcel).toHaveBeenCalledWith("var_abc");
    const req = capturedReq as { cart: { variantId: string; quantity: number; weightOz?: number; lengthIn?: number; widthIn?: number; heightIn?: number }[] };
    expect(req.cart[0].weightOz).toBe(12);
    expect(req.cart[0].lengthIn).toBe(10);
    expect(req.cart[0].widthIn).toBe(8);
    expect(req.cart[0].heightIn).toBe(4);
  });

  it("falls back to bare { variantId, quantity } when buildParcel throws, and quoting still succeeds", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_xyz") as never);
    mockBuildParcel.mockRejectedValue(new Error("no shipping data for variant var_xyz"));

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
});

describe("estimateShipping — buildParcel wiring", () => {
  it("populates dims on cart lines when buildParcel returns data", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_est") as never);
    mockBuildParcel.mockResolvedValue({
      weightOz: 5,
      lengthIn: 6,
      widthIn: 4,
      heightIn: 2,
    });

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

  it("falls back to bare line when buildParcel throws, and estimate still succeeds", async () => {
    mockPriceLines.mockResolvedValue(makePricedLines("var_noship") as never);
    mockBuildParcel.mockRejectedValue(new Error("no shipping data for variant var_noship"));

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
});
