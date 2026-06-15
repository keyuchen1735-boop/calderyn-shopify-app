import { describe, it, expect } from "vitest";
import { classifyZone, zoneMultiplier } from "../zone";

describe("zone", () => {
  it("same country is domestic", () => {
    expect(classifyZone("US", "US")).toBe("domestic");
  });
  it("US→CA is continental", () => {
    expect(classifyZone("US", "CA")).toBe("continental");
  });
  it("US→JP is international", () => {
    expect(classifyZone("US", "JP")).toBe("international");
  });
  it("unknown origin or dest falls back to domestic multiplier 1", () => {
    expect(zoneMultiplier(classifyZone(null, null))).toBe(1);
  });
  it("multipliers increase with distance", () => {
    expect(zoneMultiplier("domestic")).toBeLessThan(zoneMultiplier("continental"));
    expect(zoneMultiplier("continental")).toBeLessThan(zoneMultiplier("international"));
  });
});
