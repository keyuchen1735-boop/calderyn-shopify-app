import { describe, it, expect } from "vitest";
import { shipCostBadge } from "../provenance";

describe("shipCostBadge", () => {
  it("maps source to a merchant-facing label + tone", () => {
    expect(shipCostBadge("actual_invoice")).toEqual({ label: "Actual", tone: "success" });
    expect(shipCostBadge("actual_event")).toEqual({ label: "Actual", tone: "success" });
    expect(shipCostBadge("reconciled")).toEqual({ label: "Reconciled", tone: "info" });
    expect(shipCostBadge("manual")).toEqual({ label: "Manual", tone: "info" });
    expect(shipCostBadge("modeled")).toEqual({ label: "Modeled", tone: "attention" });
    expect(shipCostBadge("fallback")).toEqual({ label: "Estimate", tone: "warning" });
  });
  it("returns null for an absent source", () => {
    expect(shipCostBadge(null)).toBeNull();
  });
});
