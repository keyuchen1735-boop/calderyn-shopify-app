import { describe, it, expect } from "vitest";
import { createQuoteEngine } from "../engine.impl.server";
import { getShippingEngine } from "../engine.server";
import { QuoteCache } from "../cache";
import type { ShippingQuoteRequest } from "../quote";
import type {
  NormalizedRateOption,
  RateQuoteResult,
  RateQuoteSource,
} from "../../ship-cost/adapters/rate-quote";

const ADDR = { street1: "1 A St", city: "Town", state: "CA", zip: "90001", country: "US" };
const REQ: ShippingQuoteRequest = {
  cart: [{ variantId: "v1", quantity: 2, weightOz: 8 }],
  cartSubtotalCents: 5000,
  origin: ADDR,
  destination: ADDR,
  currency: "USD",
};

function carrierOpt(over: Partial<NormalizedRateOption> = {}): NormalizedRateOption {
  return {
    carrier: "USPS",
    serviceCode: "Priority",
    serviceName: "Priority",
    amountCents: 739,
    currency: "USD",
    estTransitDays: 2,
    guaranteed: false,
    deliveryDateEstimate: "2026-07-02T00:00:00Z",
    rateType: "list",
    ...over,
  };
}

// Counting fake source — proves whether the engine hit the carrier or served from cache.
function countingSource(result: RateQuoteResult): RateQuoteSource & { calls: number } {
  const s = {
    calls: 0,
    async getRates(): Promise<RateQuoteResult> {
      s.calls++;
      return result;
    },
  };
  return s;
}

const FIXED_NOW = () => new Date("2026-06-29T12:00:00Z");
function freshEngine() {
  return createQuoteEngine({ now: FIXED_NOW, cache: new QuoteCache() });
}

describe("quote engine (real impl)", () => {
  it("prices carrier options through merchant rules with a deterministic delivery window", async () => {
    const src = countingSource({
      options: [carrierOpt()],
      fallbackUsed: false,
      latencyMs: 10,
      provider: "easypost",
    });
    const q = await freshEngine()(REQ, src, { markupPct: 10, handlingCents: 500 });
    expect(q.source).toBe("carrier");
    expect(q.fallbackUsed).toBe(false);
    expect(q.options).toHaveLength(1);
    expect(q.options[0].baseAmountCents).toBe(739);
    expect(q.options[0].amountCents).toBe(1313); // round(739*1.1) + 500
    expect(q.options[0].appliedRules).toEqual(["markup:10%", "handling:500"]);
    // deliveryDateEstimate 2026-07-02 + handling(1) widens the late bound to 07-03.
    expect(q.options[0].deliveryWindow).toEqual({ earliest: "2026-07-02", latest: "2026-07-03" });
    expect(q.requestHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("zeroes shipping at the free-ship threshold and records the rule", async () => {
    const src = countingSource({
      options: [carrierOpt()],
      fallbackUsed: false,
      latencyMs: 1,
      provider: "easypost",
    });
    const q = await freshEngine()(REQ, src, { freeShipThresholdCents: 5000 });
    expect(q.options[0].amountCents).toBe(0);
    expect(q.options[0].baseAmountCents).toBe(739);
    expect(q.options[0].appliedRules).toEqual(["freeship"]);
  });

  it("surfaces adapter fallback as source=fallback / fallbackUsed=true (rule 12)", async () => {
    const src = countingSource({
      options: [carrierOpt({ carrier: "Standard", serviceCode: "Economy" })],
      fallbackUsed: true,
      latencyMs: 5000,
      provider: "easypost",
    });
    const q = await freshEngine()(REQ, src);
    expect(q.source).toBe("fallback");
    expect(q.fallbackUsed).toBe(true);
    expect(q.options.length).toBeGreaterThan(0);
  });

  it("serves an identical re-quote from cache without re-hitting the carrier", async () => {
    const src = countingSource({
      options: [carrierOpt()],
      fallbackUsed: false,
      latencyMs: 1,
      provider: "easypost",
    });
    const engine = freshEngine();
    const q1 = await engine(REQ, src);
    const q2 = await engine(REQ, src);
    expect(src.calls).toBe(1);
    expect(q2).toEqual(q1);
  });

  it("does NOT cache a degraded (fallback) quote, so carrier recovery isn't masked", async () => {
    const src = countingSource({
      options: [carrierOpt()],
      fallbackUsed: true,
      latencyMs: 1,
      provider: "easypost",
    });
    const engine = freshEngine();
    await engine(REQ, src);
    await engine(REQ, src);
    expect(src.calls).toBe(2);
  });

  it("keys the cache on merchant rules so different rules don't collide", async () => {
    const src = countingSource({
      options: [carrierOpt()],
      fallbackUsed: false,
      latencyMs: 1,
      provider: "easypost",
    });
    const engine = freshEngine();
    const a = await engine(REQ, src, { markupPct: 10 });
    const b = await engine(REQ, src, { markupPct: 20 });
    expect(src.calls).toBe(2);
    expect(a.options[0].amountCents).not.toBe(b.options[0].amountCents);
  });

  it("does NOT share a cache entry across carts differing ONLY in parcel dims (no lowConfidence leak)", async () => {
    const src = countingSource({
      options: [carrierOpt()],
      fallbackUsed: false,
      latencyMs: 1,
      provider: "easypost",
    });
    const engine = freshEngine();
    // Same variantId / quantity / weightOz (so hashShippingRequest is identical) but
    // DIFFERENT dims — the bug was these colliding on one cache key.
    const fullDims: ShippingQuoteRequest = {
      ...REQ,
      cart: [{ variantId: "v1", quantity: 2, weightOz: 8, lengthIn: 4, widthIn: 3, heightIn: 2 }],
    };
    const noDims: ShippingQuoteRequest = {
      ...REQ,
      cart: [{ variantId: "v1", quantity: 2, weightOz: 8 }],
    };
    const qFull = await engine(fullDims, src);
    const qNo = await engine(noDims, src);
    expect(src.calls).toBe(2); // cache MISS on dims difference — not a collision.
    expect(qFull.lowConfidence).toBe(false);
    // Must report ITS OWN low confidence, not the cached full-dims false (rule 12).
    expect(qNo.lowConfidence).toBe(true);
  });

  it("re-quotes after the cache TTL elapses", async () => {
    let t = 0;
    const src = countingSource({
      options: [carrierOpt()],
      fallbackUsed: false,
      latencyMs: 1,
      provider: "easypost",
    });
    const engine = createQuoteEngine({ now: () => new Date(t), cache: new QuoteCache(), cacheTtlMs: 1000 });
    await engine(REQ, src); // t=0 → cached
    t = 500;
    await engine(REQ, src); // within TTL → cache hit
    expect(src.calls).toBe(1);
    t = 2000;
    await engine(REQ, src); // past TTL → refetch
    expect(src.calls).toBe(2);
  });

  it("suppresses non-serviceable ($0) carrier rates and degrades to the fallback table", async () => {
    const src = countingSource({
      options: [carrierOpt({ amountCents: 0 })],
      fallbackUsed: false,
      latencyMs: 1,
      provider: "easypost",
    });
    const q = await freshEngine()(REQ, src);
    expect(q.fallbackUsed).toBe(true);
    expect(q.source).toBe("fallback");
    expect(q.options.length).toBeGreaterThan(0);
    expect(q.options.every((o) => o.baseAmountCents > 0)).toBe(true);
  });

  it("never returns an empty quote: an empty carrier result degrades to the fallback table", async () => {
    const src = countingSource({
      options: [],
      fallbackUsed: false,
      latencyMs: 1,
      provider: "easypost",
    });
    const q = await freshEngine()(REQ, src);
    expect(q.options.length).toBeGreaterThan(0);
    expect(q.fallbackUsed).toBe(true);
  });

  it("honors the selection strategy end-to-end", async () => {
    const src = countingSource({
      options: [
        carrierOpt({ serviceCode: "Ground", amountCents: 500 }),
        carrierOpt({ serviceCode: "Express", amountCents: 2000 }),
      ],
      fallbackUsed: false,
      latencyMs: 1,
      provider: "easypost",
    });
    const q = await freshEngine()({ ...REQ, options: { selection: "cheapest" } }, src);
    expect(q.options.map((o) => o.service)).toEqual(["Ground"]);
  });

  it("flags lowConfidence=true when cart lines lack dims/weight", async () => {
    const src = countingSource({
      options: [carrierOpt()],
      fallbackUsed: false,
      latencyMs: 1,
      provider: "easypost",
    });
    // REQ's line carries weightOz but no dims → parcel assembly had to guess.
    const q = await freshEngine()(REQ, src);
    expect(q.lowConfidence).toBe(true);
  });

  it("flags lowConfidence=false when every line is fully specified (dims + weight)", async () => {
    const src = countingSource({
      options: [carrierOpt()],
      fallbackUsed: false,
      latencyMs: 1,
      provider: "easypost",
    });
    const fullReq: ShippingQuoteRequest = {
      ...REQ,
      cart: [{ variantId: "v1", quantity: 1, weightOz: 8, lengthIn: 4, widthIn: 3, heightIn: 2 }],
    };
    const q = await freshEngine()(fullReq, src);
    expect(q.lowConfidence).toBe(false);
  });

  it("getShippingEngine() resolves to the real engine (applies rules, unlike the stub)", async () => {
    const src = countingSource({
      options: [carrierOpt()],
      fallbackUsed: false,
      latencyMs: 1,
      provider: "easypost",
    });
    const q = await getShippingEngine()(REQ, src, { markupPct: 10 });
    expect(q.options[0].appliedRules).toContain("markup:10%");
  });
});
