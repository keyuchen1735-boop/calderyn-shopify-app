import { describe, it, expect, vi, beforeEach } from "vitest";

// The adapter mock must also export buildFallbackOptions — the default-bands
// source reuses the real table's builder.
const fallbackOption = {
  carrier: "Standard",
  serviceCode: "Economy",
  serviceName: "Economy",
  amountCents: 599,
  currency: "USD",
  estTransitDays: 7,
  guaranteed: false,
  deliveryDateEstimate: null,
  rateType: "list" as const,
};

function mockAdapter(connectResult: unknown) {
  vi.doMock("~/lib/ship-cost/adapters/easypost-rate.server", () => ({
    easyPostRateAdapter: { connect: async () => connectResult },
    buildFallbackOptions: () => [fallbackOption],
  }));
}

function mockFlatRates(rows: unknown[]) {
  vi.doMock("~/lib/shipping/flat-rate.server", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return { ...actual, loadFlatRates: async () => rows };
  });
}

const req = {
  origin: { street1: "", city: "", state: "", zip: "97201", country: "US" },
  destination: { street1: "", city: "", state: "", zip: "10001", country: "US" },
  parcels: [{ lengthIn: 0, widthIn: 0, heightIn: 0, weightOz: 16 }],
};

describe("resolveRateSource", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("prefers the connected EasyPost RateQuoteSource", async () => {
    const src = { getRates: async () => ({ options: [], fallbackUsed: false, latencyMs: 0, provider: "easypost" }) };
    mockAdapter(src);
    mockFlatRates([]);
    const { resolveRateSource } = await import("./rate-source.server");
    const resolved = await resolveRateSource("shop_test");
    expect(resolved.kind).toBe("carrier");
    expect(resolved.source).toBe(src);
  });

  it("uses merchant flat rates when no carrier is connected", async () => {
    mockAdapter(null);
    mockFlatRates([
      {
        id: "r1",
        label: "Standard",
        zone: "all",
        maxWeightOz: null,
        amountCents: 750,
        estTransitDays: 5,
        position: 0,
        updatedAt: "2026-07-10T00:00:00Z",
      },
    ]);
    const { resolveRateSource } = await import("./rate-source.server");
    const resolved = await resolveRateSource("shop_test");
    expect(resolved.kind).toBe("flat");
    const rates = await resolved.source.getRates(req);
    expect(rates.fallbackUsed).toBe(false);
    expect(rates.options).toHaveLength(1);
    expect(rates.options[0]).toMatchObject({ serviceName: "Standard", amountCents: 750 });
  });

  it("degrades to the built-in bands (fallbackUsed) with zero setup — never throws", async () => {
    mockAdapter(null);
    mockFlatRates([]);
    const { resolveRateSource, getRateSource } = await import("./rate-source.server");
    const resolved = await resolveRateSource("shop_test");
    expect(resolved.kind).toBe("default");
    const rates = await resolved.source.getRates(req);
    expect(rates.fallbackUsed).toBe(true);
    expect(rates.options.length).toBeGreaterThan(0);
    // getRateSource keeps the plain-source shape for the quote pipeline.
    await expect(getRateSource("shop_test")).resolves.toBeTruthy();
  });

  it("still throws when a stored credential is structurally broken", async () => {
    vi.doMock("~/lib/ship-cost/adapters/easypost-rate.server", () => ({
      easyPostRateAdapter: {
        connect: async () => {
          throw new Error("decrypt failed");
        },
      },
      buildFallbackOptions: () => [fallbackOption],
    }));
    mockFlatRates([]);
    const { getRateSource } = await import("./rate-source.server");
    await expect(getRateSource("shop_test")).rejects.toThrow("decrypt failed");
  });
});
