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

describe("restrictedVariants", () => {
  it("returns the variants whose restricted_countries includes the destination", async () => {
    rows = [
      { variant_id: "a", restricted_countries: ["CA", "MX"] },
      { variant_id: "b", restricted_countries: [] },
    ];
    const { restrictedVariants } = await import("../parcel.server");
    expect(await restrictedVariants(["a", "b"], "CA")).toEqual(["a"]);
  });

  it("is case-insensitive on the destination country", async () => {
    rows = [{ variant_id: "a", restricted_countries: ["CA"] }];
    const { restrictedVariants } = await import("../parcel.server");
    expect(await restrictedVariants(["a"], "ca")).toEqual(["a"]);
  });

  it("treats a variant with no shipping row as unrestricted (permissive, matches buildParcel)", async () => {
    rows = []; // variant absent from variant_shipping (e.g. pre-migration)
    const { restrictedVariants } = await import("../parcel.server");
    expect(await restrictedVariants(["missing"], "CA")).toEqual([]);
  });

  it("returns empty for empty input", async () => {
    const { restrictedVariants } = await import("../parcel.server");
    expect(await restrictedVariants([], "CA")).toEqual([]);
  });
});
