import { describe, it, expect } from "vitest";
import { detectorLabel, detectorTerm } from "../labels";

// P2-10: both surfaces must show the same plain-English detector name, and a
// detector id without a mapping must never leak raw snake_case to merchants.
describe("detectorLabel / detectorTerm", () => {
  it("returns the plain-English label for a known detector", () => {
    expect(detectorLabel("negative_unit_economics")).toBe("Losing money on every sale");
    expect(detectorLabel("scaling_sku_fulfillment_risk")).toBe("Best-seller may sell out");
  });

  it("returns the analyst term for a known detector", () => {
    expect(detectorTerm("negative_unit_economics")).toBe("Negative unit economics");
  });

  it("humanizes an unmapped detector id instead of leaking snake_case", () => {
    expect(detectorLabel("some_new_detector_id")).toBe("Some New Detector Id");
    expect(detectorLabel("some_new_detector_id")).not.toContain("_");
    expect(detectorTerm("another_unmapped")).toBe("Another Unmapped");
  });
});
