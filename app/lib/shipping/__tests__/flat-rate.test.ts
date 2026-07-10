import { describe, it, expect } from "vitest";
import { buildFlatRateOptions, buildMerchantFlatRateSource, pickBand, type FlatRateRow } from "../flat-rate.server";
import type { RateRequest } from "~/lib/ship-cost/adapters/rate-quote";

function row(over: Partial<FlatRateRow>): FlatRateRow {
  return {
    id: "r",
    label: "Standard",
    zone: "all",
    maxWeightOz: null,
    amountCents: 500,
    estTransitDays: 5,
    position: 0,
    updatedAt: "2026-07-10T00:00:00Z",
    ...over,
  };
}

function req(destCountry: string, weightOz: number): RateRequest {
  return {
    origin: { street1: "", city: "", state: "", zip: "97201", country: "US" },
    destination: { street1: "", city: "", state: "", zip: "10001", country: destCountry },
    parcels: [{ lengthIn: 0, widthIn: 0, heightIn: 0, weightOz }],
  };
}

describe("pickBand", () => {
  const bands = [
    row({ id: "a", maxWeightOz: 16, amountCents: 500 }),
    row({ id: "b", maxWeightOz: 48, amountCents: 900 }),
  ];

  it("picks the tightest cap that fits", () => {
    expect(pickBand(bands, 10)?.id).toBe("a");
    expect(pickBand(bands, 30)?.id).toBe("b");
  });

  it("falls to the uncapped row when the parcel outgrows every cap", () => {
    const withUncapped = [...bands, row({ id: "c", maxWeightOz: null, amountCents: 1500 })];
    expect(pickBand(withUncapped, 100)?.id).toBe("c");
  });

  it("uses the LARGEST cap (never a cheaper smaller band) when nothing fits and no uncapped row exists", () => {
    expect(pickBand(bands, 100)?.id).toBe("b");
  });
});

describe("buildFlatRateOptions", () => {
  it("matches zone by origin-vs-destination country and sorts by price", () => {
    const rows = [
      row({ id: "d", label: "Domestic", zone: "domestic", amountCents: 500 }),
      row({ id: "i", label: "International", zone: "international", amountCents: 2500 }),
      row({ id: "e", label: "Express", zone: "all", amountCents: 200 }),
    ];
    const domestic = buildFlatRateOptions(rows, req("US", 8));
    expect(domestic.map((o) => o.serviceName)).toEqual(["Express", "Domestic"]);
    const intl = buildFlatRateOptions(rows, req("CA", 8));
    expect(intl.map((o) => o.serviceName)).toEqual(["Express", "International"]);
  });

  it("prices each label group by its own weight band", () => {
    const rows = [
      row({ id: "s1", label: "Standard", maxWeightOz: 16, amountCents: 500 }),
      row({ id: "s2", label: "Standard", maxWeightOz: 160, amountCents: 1200 }),
    ];
    expect(buildFlatRateOptions(rows, req("US", 8))[0].amountCents).toBe(500);
    expect(buildFlatRateOptions(rows, req("US", 100))[0].amountCents).toBe(1200);
  });

  it("returns empty when no row matches the zone (engine degrades to built-in bands)", () => {
    const rows = [row({ zone: "domestic" })];
    expect(buildFlatRateOptions(rows, req("CA", 8))).toEqual([]);
  });
});

describe("buildMerchantFlatRateSource", () => {
  it("is authoritative (fallbackUsed=false) and version-keys its cache id on count + updated_at", async () => {
    const rows = [row({ updatedAt: "2026-07-10T12:00:00Z" })];
    const source = buildMerchantFlatRateSource("shop_1", rows);
    expect(source.id).toBe("merchant-flat:shop_1:1:2026-07-10T12:00:00Z");
    const result = await source.getRates(req("US", 8));
    expect(result.fallbackUsed).toBe(false);
    expect(result.provider).toBe("merchant");
    expect(result.options).toHaveLength(1);
  });

  it("cache id changes when a NON-newest row is deleted (count in the version)", () => {
    const newest = row({ id: "n", updatedAt: "2026-07-10T12:00:00Z" });
    const older = row({ id: "o", updatedAt: "2026-07-01T00:00:00Z" });
    const before = buildMerchantFlatRateSource("shop_1", [older, newest]);
    const after = buildMerchantFlatRateSource("shop_1", [newest]);
    expect(before.id).not.toBe(after.id);
  });
});
