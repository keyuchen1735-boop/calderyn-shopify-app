import { describe, it, expect } from "vitest";
import { REGION_STATES, googleGeoTargetConstants } from "../geo-regions";

const REGIONS = ["us-west", "us-east", "us-south", "us-central"] as const;

describe("geo-regions", () => {
  it("every region maps to a non-empty, disjoint state list covering 50 states + DC", () => {
    const all = REGIONS.flatMap((r) => REGION_STATES[r]);
    expect(new Set(all).size).toBe(all.length); // disjoint (no state in two regions)
    expect(new Set(all).size).toBe(51); // 50 states + DC
    for (const r of REGIONS) expect(REGION_STATES[r].length).toBeGreaterThan(0);
  });

  it("every state in every region resolves to a Google geoTargetConstant", () => {
    for (const r of REGIONS) {
      const ids = googleGeoTargetConstants(r);
      expect(ids.length).toBe(REGION_STATES[r].length);
      for (const id of ids) expect(id).toMatch(/^geoTargetConstants\/\d+$/);
    }
  });

  it("Google geo target IDs are unique across all states", () => {
    const ids = REGIONS.flatMap((r) => googleGeoTargetConstants(r));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
