import { describe, it, expect } from "vitest";
import { detectorLabel, detectorTerm, alertDetectorLabel } from "../labels";

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

  it("reframes a 'may sell out' alert as sold out when stock is already 0 (P2-11)", () => {
    expect(
      alertDetectorLabel("scaling_sku_fulfillment_risk", { stock: "0" }),
    ).toBe("Best-seller sold out");
    expect(
      alertDetectorLabel("scaling_sku_fulfillment_risk", { days_of_cover: 0 }),
    ).toBe("Best-seller sold out");
  });

  it("keeps 'may sell out' while stock remains", () => {
    expect(
      alertDetectorLabel("scaling_sku_fulfillment_risk", { stock: "120", days_of_cover: "8" }),
    ).toBe("Best-seller may sell out");
  });
});
