import { describe, it, expect } from "vitest";
import { regionForGeoTargets } from "../geo-regions";

describe("regionForGeoTargets", () => {
  it("resolves a single RegionCode literal (seed shops)", () => {
    expect(regionForGeoTargets(["us-west"])).toBe("us-west");
  });
  it("resolves Google geoTargetConstants that all fall in one region", () => {
    expect(regionForGeoTargets(["geoTargetConstants/21167", "geoTargetConstants/21163"])).toBe("us-east");
  });
  it("returns null when targets span multiple regions", () => {
    expect(regionForGeoTargets(["us-east", "us-west"])).toBeNull();
    expect(regionForGeoTargets(["geoTargetConstants/21167", "geoTargetConstants/21137"])).toBeNull();
  });
  it("returns null for empty targets (Meta/TikTok, national)", () => {
    expect(regionForGeoTargets([])).toBeNull();
  });
  it("returns null for an unrecognized target (conservative — do not act)", () => {
    expect(regionForGeoTargets(["geoTargetConstants/999999"])).toBeNull();
    expect(regionForGeoTargets(["country/US"])).toBeNull();
  });
});
