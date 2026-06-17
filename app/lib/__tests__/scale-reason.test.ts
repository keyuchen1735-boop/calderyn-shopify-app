import { describe, it, expect } from "vitest";
import { scaleReason } from "../scale-reason";

describe("scaleReason", () => {
  it("includes the performance clause and rounded monthly upside", () => {
    // 239064 cents -> $2,391 (rounded); roas 8.1147 -> 8.1x.
    expect(scaleReason(8.1147, 20, 239064)).toBe(
      "Winning campaign earning 8.1× on ad spend. Raising its budget 20% projects about +$2,391/mo more profit if it keeps performing.",
    );
  });

  it("omits the ROAS clause when roas is unavailable (null or 0)", () => {
    const expected =
      "Winning campaign. Raising its budget 20% projects about +$2,391/mo more profit if it keeps performing.";
    expect(scaleReason(null, 20, 239064)).toBe(expected);
    expect(scaleReason(0, 20, 239064)).toBe(expected);
  });

  it("formats large upsides with thousands separators", () => {
    expect(scaleReason(5.0, 15, 1234567)).toContain("+$12,346/mo");
  });
});
