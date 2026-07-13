import { describe, it, expect, vi, beforeEach } from "vitest";

let row: Record<string, unknown> | null = {
  weight_grams: 340,
  length_mm: 127,
  width_mm: 127,
  height_mm: 102,
  restricted_countries: ["CA"],
};
let rows: Array<Record<string, unknown>> = [];

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: row, error: null }),
        }),
        in: () => Promise.resolve({ data: rows, error: null }),
      }),
    }),
  }),
}));

beforeEach(() => {
  row = {
    weight_grams: 340,
    length_mm: 127,
    width_mm: 127,
    height_mm: 102,
    restricted_countries: ["CA"],
  };
  rows = [];
});

describe("buildParcel", () => {
  it("converts grams→oz and mm→inches", async () => {
    const { buildParcel } = await import("../parcel.server");
    const p = await buildParcel("v1");
    expect(p.weightOz).toBeCloseTo(11.99, 1); // 340g
    expect(p.lengthIn).toBeCloseTo(5, 2);      // 127mm
    expect(p.heightIn).toBeCloseTo(4.02, 2);   // 102mm
  });

  it("canShipTo is false for a restricted country", async () => {
    const { canShipTo } = await import("../parcel.server");
    expect(await canShipTo("v1", "ca")).toBe(false);
    expect(await canShipTo("v1", "us")).toBe(true);
  });

  it("canShipTo throws when the variant has no shipping row", async () => {
    row = null;
    const { canShipTo } = await import("../parcel.server");
    await expect(canShipTo("missing", "us")).rejects.toThrow();
  });
});

describe("cartShipInfo", () => {
  it("returns the variants whose restricted_countries includes the destination", async () => {
    rows = [
      { variant_id: "a", restricted_countries: ["CA", "MX"] },
      { variant_id: "b", restricted_countries: [] },
    ];
    const { cartShipInfo } = await import("../parcel.server");
    expect((await cartShipInfo(["a", "b"], "CA")).blocked).toEqual(["a"]);
  });

  it("is case-insensitive on the destination country", async () => {
    rows = [{ variant_id: "a", restricted_countries: ["CA"] }];
    const { cartShipInfo } = await import("../parcel.server");
    expect((await cartShipInfo(["a"], "ca")).blocked).toEqual(["a"]);
  });

  it("treats a variant with no shipping row as unrestricted (permissive, matches buildParcel)", async () => {
    rows = []; // variant absent from variant_shipping (e.g. pre-migration)
    const { cartShipInfo } = await import("../parcel.server");
    const info = await cartShipInfo(["missing"], "CA");
    expect(info.blocked).toEqual([]);
    expect(info.parcelByVariant.has("missing")).toBe(false); // no parcel → low-confidence path
  });

  it("returns empty for empty input", async () => {
    const { cartShipInfo } = await import("../parcel.server");
    expect((await cartShipInfo([], "CA")).blocked).toEqual([]);
  });

  it("carries the slowest handling window and converted parcels in the same read", async () => {
    rows = [
      { variant_id: "a", restricted_countries: [], handling_days: 2, weight_grams: 340, length_mm: 127, width_mm: 127, height_mm: 102 },
      { variant_id: "b", restricted_countries: [], handling_days: 5, weight_grams: 100 },
    ];
    const { cartShipInfo } = await import("../parcel.server");
    const info = await cartShipInfo(["a", "b"], "US");
    expect(info.maxHandlingDays).toBe(5);
    expect(info.parcelByVariant.get("a")?.weightOz).toBeCloseTo(11.99, 1);
    expect(info.parcelByVariant.get("a")?.lengthIn).toBeCloseTo(5, 2);
    expect(info.parcelByVariant.get("b")?.weightOz).toBeCloseTo(3.53, 2);
  });
});
