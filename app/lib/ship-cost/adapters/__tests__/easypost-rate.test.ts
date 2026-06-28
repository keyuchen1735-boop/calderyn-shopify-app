import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  fetchEasyPostRates,
  easyPostRateAdapter,
  type EasyPostRateQuote,
} from "../easypost-rate.server";

// vi.mock is hoisted above the imports by vitest; the factory dereferences
// maybeSingleMock lazily (only when connect() reads it), so this placement is safe.
const maybeSingleMock = vi.fn();
vi.mock("../../../supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }) }),
    }),
  }),
}));
vi.mock("../../../crypto.server", () => ({
  decrypt: (cipher: string) => {
    if (cipher === "enc(broken)") throw new Error("malformed ciphertext");
    return `key_for_${cipher}`;
  },
}));

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

// ── fetchEasyPostRates: POST /v2/shipments → normalize ALL rates[] ──────────────
function sampleReq(serviceFilter?: string[]): RateRequest {
  return {
    origin: { name: "Shop", street1: "1 A St", city: "SF", state: "CA", zip: "94016", country: "US" },
    destination: { name: "Buyer", street1: "2 B St", city: "NYC", state: "NY", zip: "10001", country: "US" },
    parcels: [{ lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 32 }],
    serviceFilter,
  };
}

function okJson(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as Response;
}

describe("fetchEasyPostRates — happy path", () => {
  it("POSTs the shipment with to/from/parcel and HTTP Basic auth", async () => {
    const mockFetch = vi.fn(async (_url: string, _init?: RequestInit) => okJson(rateFixture));
    await fetchEasyPostRates("EZTKtest123", sampleReq(), mockFetch as unknown as typeof fetch);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.easypost.com/v2/shipments");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("EZTKtest123:").toString("base64")}`);
    const body = JSON.parse(init.body as string);
    expect(body.shipment.parcel.weight).toBe(32); // EasyPost parcel weight is OUNCES.
    expect(body.shipment.to_address.zip).toBe("10001");
    expect(body.shipment.from_address.zip).toBe("94016");
  });

  it("normalizes ALL rates[] (not selected_rate) and drops the malformed one", async () => {
    const mockFetch = vi.fn(async () => okJson(rateFixture));
    const result = await fetchEasyPostRates("k", sampleReq(), mockFetch as unknown as typeof fetch);
    expect(result.fallbackUsed).toBe(false);
    expect(result.provider).toBe("easypost");
    expect(result.options.map((o) => `${o.carrier}:${o.serviceCode}:${o.amountCents}`)).toEqual([
      "USPS:Priority:739",
      "USPS:Express:2695",
      "UPS:Ground:912",
    ]);
  });

  it("applies serviceFilter client-side to the returned options", async () => {
    const mockFetch = vi.fn(async () => okJson(rateFixture));
    const result = await fetchEasyPostRates("k", sampleReq(["Priority"]), mockFetch as unknown as typeof fetch);
    expect(result.options.map((o) => o.serviceCode)).toEqual(["Priority"]);
  });
});

// ── fetchEasyPostRates: degrade-to-fallback, NEVER throw at runtime ─────────────
describe("fetchEasyPostRates — timeout & fallback", () => {
  it("returns the static fallback (fallbackUsed:true) WITHOUT throwing when the carrier times out", async () => {
    vi.useFakeTimers();
    // fetch that never resolves on its own and rejects only when the AbortController fires.
    const hangingFetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const promise = fetchEasyPostRates("k", sampleReq(), hangingFetch as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(5000); // trip RATE_TIMEOUT_MS.
    const result = await promise;
    expect(result.fallbackUsed).toBe(true);
    expect(result.options.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("falls back on a non-2xx response without throwing", async () => {
    const mockFetch = vi.fn(async () =>
      ({ ok: false, status: 500, statusText: "ISE", text: async () => "boom", json: async () => ({}) } as Response));
    const result = await fetchEasyPostRates("k", sampleReq(), mockFetch as unknown as typeof fetch);
    expect(result.fallbackUsed).toBe(true);
    expect(result.options.length).toBeGreaterThan(0);
  });

  it("falls back when rates[] is EMPTY (rate-shopping creds not configured)", async () => {
    const mockFetch = vi.fn(async () => okJson({ id: "shp_x", rates: [] }));
    const result = await fetchEasyPostRates("k", sampleReq(), mockFetch as unknown as typeof fetch);
    expect(result.fallbackUsed).toBe(true);
  });

  it("falls back on a malformed body (json() throws) without throwing", async () => {
    const mockFetch = vi.fn(async () =>
      ({ ok: true, status: 200, statusText: "OK", json: async () => { throw new Error("bad json"); } } as unknown as Response));
    const result = await fetchEasyPostRates("k", sampleReq(), mockFetch as unknown as typeof fetch);
    expect(result.fallbackUsed).toBe(true);
  });

  it("falls back when every rate is malformed/dropped (never returns zero options)", async () => {
    const mockFetch = vi.fn(async () => okJson({ id: "shp_x", rates: [{ carrier: "USPS", service: "X", rate: "-1.00" }] }));
    const result = await fetchEasyPostRates("k", sampleReq(), mockFetch as unknown as typeof fetch);
    expect(result.fallbackUsed).toBe(true);
  });
});

describe("easyPostRateAdapter.connect", () => {
  beforeEach(() => maybeSingleMock.mockReset());

  it("exposes the provider-blind adapter identity", () => {
    expect(easyPostRateAdapter.provider).toBe("easypost");
    expect(easyPostRateAdapter.integrationKind).toBe("easypost_ship");
  });

  it("returns null when NO credential row exists (shop not connected)", async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    expect(await easyPostRateAdapter.connect("shop-1")).toBeNull();
  });

  it("returns a RateQuoteSource exposing getRates when a credential is stored", async () => {
    maybeSingleMock.mockResolvedValue({ data: { access_token_encrypted: "enc(ok)" }, error: null });
    const source = await easyPostRateAdapter.connect("shop-1");
    expect(source).not.toBeNull();
    expect(typeof source?.getRates).toBe("function");
  });

  it("THROWS when a credential is stored but the ciphertext is broken (rule 12, not a silent null)", async () => {
    maybeSingleMock.mockResolvedValue({ data: { access_token_encrypted: "enc(broken)" }, error: null });
    await expect(easyPostRateAdapter.connect("shop-1")).rejects.toThrow(/malformed ciphertext/);
  });

  it("THROWS when the credential read itself errors", async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: new Error("db down") });
    await expect(easyPostRateAdapter.connect("shop-1")).rejects.toThrow(/db down/);
  });
});
