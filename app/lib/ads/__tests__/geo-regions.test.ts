import { describe, it, expect } from "vitest";
import {
  REGION_STATES,
  US_STATE_NAMES,
  regionStateNames,
  googleGeoTargetConstants,
} from "../geo-regions";

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

// Meta resolves a US state to its numeric region key at runtime via the
// adgeolocation targeting-search API (keyed by the state's full name). The name
// table is the stable, verifiable input; a missing or duplicate name fails the
// build so the live resolver can never be handed an empty query.
describe("US_STATE_NAMES (Meta region resolution)", () => {
  it("maps every region's state to a unique, non-empty full name", () => {
    const allStates = REGIONS.flatMap((r) => REGION_STATES[r]);
    for (const s of allStates) {
      expect(typeof US_STATE_NAMES[s]).toBe("string");
      expect(US_STATE_NAMES[s].length).toBeGreaterThan(0);
    }
    const names = allStates.map((s) => US_STATE_NAMES[s]);
    expect(new Set(names).size).toBe(names.length); // unique (exact-name match must disambiguate)
    expect(new Set(names).size).toBe(51); // 50 states + DC
  });

  it("regionStateNames returns the full name of every state in the region", () => {
    for (const r of REGIONS) {
      const names = regionStateNames(r);
      expect(names.length).toBe(REGION_STATES[r].length);
      for (const n of names) expect(n.length).toBeGreaterThan(0);
    }
    // us-east includes DC, whose full name is "District of Columbia".
    expect(regionStateNames("us-east")).toContain("District of Columbia");
  });
});
