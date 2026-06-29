import { describe, it, expect } from "vitest";
import { stubQuoteShipping, hashShippingRequest } from "../engine.stub.server";
import type { ShippingQuoteRequest } from "../quote";
import type { RateQuoteResult, RateQuoteSource } from "../../ship-cost/adapters/rate-quote";

const ADDR = { street1: "1 A St", city: "Town", state: "CA", zip: "90001", country: "US" };

const REQ: ShippingQuoteRequest = {
  cart: [{ variantId: "v1", quantity: 2, weightOz: 8 }],
  cartSubtotalCents: 5000,
  origin: ADDR,
  destination: ADDR,
  currency: "USD",
};

function fakeSource(result: RateQuoteResult): RateQuoteSource {
  return { getRates: async () => result };
}

describe("stubQuoteShipping", () => {
  it("maps carrier options 1:1 with no rules applied and source=carrier", async () => {
    const q = await stubQuoteShipping(
      REQ,
      fakeSource({
        options: [
          {
            carrier: "USPS",
            serviceCode: "Priority",
            serviceName: "Priority",
            amountCents: 739,
            currency: "USD",
            estTransitDays: 2,
            guaranteed: false,
            deliveryDateEstimate: "2026-07-02",
            rateType: "list",
          },
        ],
        fallbackUsed: false,
        latencyMs: 12,
        provider: "easypost",
      }),
    );
    expect(q.options).toHaveLength(1);
    expect(q.options[0].amountCents).toBe(739);
    expect(q.options[0].baseAmountCents).toBe(739);
    expect(q.options[0].appliedRules).toEqual([]);
    expect(q.options[0].deliveryWindow).toEqual({ earliest: "2026-07-02", latest: "2026-07-02" });
    expect(q.source).toBe("carrier");
    expect(q.fallbackUsed).toBe(false);
  });

  it("surfaces fallback degradation (rule 12) as source=fallback", async () => {
    const q = await stubQuoteShipping(
      REQ,
      fakeSource({ options: [], fallbackUsed: true, latencyMs: 5000, provider: "easypost" }),
    );
    expect(q.source).toBe("fallback");
    expect(q.fallbackUsed).toBe(true);
  });

  it("hashShippingRequest is stable for identical requests and differs on change", () => {
    expect(hashShippingRequest(REQ)).toBe(hashShippingRequest(REQ));
    expect(hashShippingRequest(REQ)).not.toBe(
      hashShippingRequest({ ...REQ, cartSubtotalCents: 9999 }),
    );
  });
});
