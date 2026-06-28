import { describe, it, expect, vi, afterEach } from "vitest";
import { basicAuthHeader, apiBase } from "../easypost.server";
import type {
  NormalizedRateOption,
  RateRequest,
  RateQuoteResult,
  Address,
  Parcel,
} from "../rate-quote";

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
