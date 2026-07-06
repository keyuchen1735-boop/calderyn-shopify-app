import { describe, it, expect } from "vitest";
import { REGION_CENTROIDS } from "../regions";
import { VALID_REGIONS } from "../../ads/actions";

describe("REGION_CENTROIDS", () => {
  it("has exactly one centroid per RegionCode", () => {
    const regions = REGION_CENTROIDS.map((c) => c.region).sort();
    expect(regions).toEqual([...VALID_REGIONS].sort());
  });

  it("centroids are plausible US coordinates", () => {
    for (const c of REGION_CENTROIDS) {
      expect(c.lat).toBeGreaterThan(24);
      expect(c.lat).toBeLessThan(50);
      expect(c.lon).toBeGreaterThan(-125);
      expect(c.lon).toBeLessThan(-66);
    }
  });
});
