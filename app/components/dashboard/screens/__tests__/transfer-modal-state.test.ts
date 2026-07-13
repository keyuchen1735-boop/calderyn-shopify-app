import { describe, expect, it } from "vitest";
import { transferValidation } from "../transfer-modal-state";

describe("transferValidation", () => {
  it("passes a complete, in-stock move", () => {
    expect(transferValidation("loc-a", "loc-b", 3, 10)).toBeNull();
  });

  it("requires both locations", () => {
    expect(transferValidation("", "loc-b", 1, null)).toBe("Pick both locations.");
    expect(transferValidation("loc-a", "", 1, null)).toBe("Pick both locations.");
  });

  it("rejects same-location moves", () => {
    expect(transferValidation("loc-a", "loc-a", 1, null)).toBe(
      "Pick two different locations.",
    );
  });

  it("requires a whole quantity of at least 1", () => {
    expect(transferValidation("loc-a", "loc-b", 0, null)).toBe(
      "Quantity must be at least 1.",
    );
    expect(transferValidation("loc-a", "loc-b", -4, null)).toBe(
      "Quantity must be at least 1.",
    );
    expect(transferValidation("loc-a", "loc-b", Number.NaN, null)).toBe(
      "Quantity must be at least 1.",
    );
  });

  it("caps the quantity at the source availability", () => {
    expect(transferValidation("loc-a", "loc-b", 5, 3)).toBe(
      "Only 3 available at the source location.",
    );
  });

  it("allows exactly the available quantity", () => {
    expect(transferValidation("loc-a", "loc-b", 3, 3)).toBeNull();
  });

  it("passes through when availability is unknown", () => {
    expect(transferValidation("loc-a", "loc-b", 999, null)).toBeNull();
  });
});
