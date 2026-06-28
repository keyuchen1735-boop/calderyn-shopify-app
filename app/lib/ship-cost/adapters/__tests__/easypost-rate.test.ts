import { describe, it, expect, vi, afterEach } from "vitest";
import { basicAuthHeader, apiBase } from "../easypost.server";
import type {
  NormalizedRateOption,
  RateRequest,
  RateQuoteResult,
  Address,
  Parcel,
} from "../rate-quote";
import rateFixture from "./fixtures/easypost-rates.json";
import {
  mapRateToOption,
  buildFallbackOptions,
  type EasyPostRateQuote,
} from "../easypost-rate.server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── easypost.server shared HTTP helpers, exported for reuse by the rate adapter ──
describe("easypost.server exported helpers", () => {
  it("basicAuthHeader emits HTTP Basic with the key as username + empty password", () => {
    expect(basicAuthHeader("EZTKtest123")).toBe(
      `Basic ${Buffer.from("EZTKtest123:").toString("base64")}`,
    );
  });

  it("apiBase defaults to the production v2 base and strips a trailing slash from an override", () => {
    const prev = process.env.EASYPOST_API_BASE;
    delete process.env.EASYPOST_API_BASE;
    expect(apiBase()).toBe("https://api.easypost.com/v2");
    process.env.EASYPOST_API_BASE = "https://example.test/v2/";
    expect(apiBase()).toBe("https://example.test/v2");
    if (prev === undefined) delete process.env.EASYPOST_API_BASE;
    else process.env.EASYPOST_API_BASE = prev;
  });
});

// ── rate-quote.ts contract: shape guards (tsc enforces; runtime confirms) ───────
describe("rate-quote contract types", () => {
  it("a NormalizedRateOption literal satisfies the contract shape", () => {
    const opt = {
      carrier: "USPS",
      serviceCode: "Priority",
      serviceName: "Priority",
      amountCents: 739,
      currency: "USD",
      estTransitDays: 2,
      guaranteed: false,
      deliveryDateEstimate: null,
      rateType: "list",
    } satisfies NormalizedRateOption;
    expect(opt.amountCents).toBe(739);
    expect(opt.rateType).toBe("list");
  });

  it("a RateRequest literal satisfies the contract shape (origin/destination/parcels)", () => {
    const origin: Address = { street1: "1 A St", city: "SF", state: "CA", zip: "94016", country: "US" };
    const destination: Address = { street1: "2 B St", city: "NYC", state: "NY", zip: "10001", country: "US" };
    const parcel: Parcel = { lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 32 };
    const req = { origin, destination, parcels: [parcel] } satisfies RateRequest;
    expect(req.parcels[0].weightOz).toBe(32);
  });

  it("a RateQuoteResult carries fallbackUsed + latencyMs visibility fields", () => {
    const res = { options: [], fallbackUsed: true, latencyMs: 12, provider: "easypost" } satisfies RateQuoteResult;
    expect(res.fallbackUsed).toBe(true);
  });
});

// ── mapRateToOption: one EasyPost rate → NormalizedRateOption (parseRateToCents reuse) ──
describe("mapRateToOption (pure normalization)", () => {
  const rates = rateFixture.rates as EasyPostRateQuote[];

  it('maps a USPS Priority "7.39" rate to 739 cents with every field', () => {
    expect(mapRateToOption(rates[0])).toEqual({
      carrier: "USPS",
      serviceCode: "Priority",
      serviceName: "Priority",
      amountCents: 739,
      currency: "USD",
      estTransitDays: 2,
      guaranteed: false,
      deliveryDateEstimate: "2026-07-02T00:00:00Z",
      rateType: "list",
    });
  });

  it("reads guaranteed + delivery_date for an Express rate", () => {
    const opt = mapRateToOption(rates[1]);
    expect(opt?.amountCents).toBe(2695);
    expect(opt?.guaranteed).toBe(true);
    expect(opt?.deliveryDateEstimate).toBe("2026-07-01T00:00:00Z");
  });

  it("falls back delivery_days → est_delivery_days, and delivery_date → null", () => {
    const opt = mapRateToOption(rates[2]);
    expect(opt?.estTransitDays).toBe(3);
    expect(opt?.deliveryDateEstimate).toBeNull();
  });

  it("DROPS a negative/malformed rate (null), never coerces to 0 (rule 12)", () => {
    expect(mapRateToOption(rates[3])).toBeNull();
  });

  it("drops a rate missing carrier or service (cannot present an option)", () => {
    expect(mapRateToOption({ service: "Priority", rate: "5.00" })).toBeNull();
    expect(mapRateToOption({ carrier: "USPS", rate: "5.00" })).toBeNull();
  });
});

// ── buildFallbackOptions: static table (load-bearing — no rate = no sale) ────────
function fallbackReq(weightOz: number): RateRequest {
  return {
    origin: { street1: "1 A St", city: "SF", state: "CA", zip: "94016", country: "US" },
    destination: { street1: "2 B St", city: "NYC", state: "NY", zip: "10001", country: "US" },
    parcels: [{ lengthIn: 10, widthIn: 8, heightIn: 4, weightOz }],
  };
}

describe("buildFallbackOptions (static table)", () => {
  it("returns a NON-EMPTY conservative set (economy + expedited)", () => {
    const opts = buildFallbackOptions(fallbackReq(20));
    expect(opts.length).toBeGreaterThanOrEqual(1);
    expect(opts.map((o) => o.serviceCode)).toEqual(["Economy", "Expedited"]);
  });

  it("prices a heavier parcel into a higher band", () => {
    const light = buildFallbackOptions(fallbackReq(8))[0].amountCents;
    const heavy = buildFallbackOptions(fallbackReq(100))[0].amountCents;
    expect(heavy).toBeGreaterThan(light);
  });

  it("never marks a fallback option guaranteed, and uses integer cents", () => {
    for (const o of buildFallbackOptions(fallbackReq(500))) {
      expect(o.guaranteed).toBe(false);
      expect(Number.isInteger(o.amountCents)).toBe(true);
      expect(o.deliveryDateEstimate).toBeNull();
    }
  });
});
