import { describe, it, expect, vi } from "vitest";
const shipping = { weight_grams: 340, length_mm: 127, width_mm: 127, height_mm: 102, restricted_countries: ["CA"] };
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: shipping, error: null }) }) }) }) }),
}));
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
});
