import { describe, expect, it } from "vitest";
import { variantSummary } from "../new-product-copy";

describe("variantSummary", () => {
  it("summarizes combos with a base price", () => {
    expect(variantSummary(6, "24.99")).toBe(
      "6 variants — all $24.99 unless you change them",
    );
  });
  it("summarizes without a price", () => {
    expect(variantSummary(2, "")).toBe("2 variants — same price and stock");
  });
  it("uses the singular for one variant", () => {
    expect(variantSummary(1, "")).toBe("1 variant — same price and stock");
  });
});
