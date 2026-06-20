import { describe, it, expect } from "vitest";
import {
  buildSkuTitle,
  cleanVariantTitle,
  splitSkuTitle,
} from "../sku-title";

describe("cleanVariantTitle", () => {
  it("returns null for Default Title / blank / missing", () => {
    expect(cleanVariantTitle("The Hidden Snowboard", "Default Title")).toBeNull();
    expect(cleanVariantTitle("The Hidden Snowboard", "")).toBeNull();
    expect(cleanVariantTitle("The Hidden Snowboard", null)).toBeNull();
    expect(cleanVariantTitle("The Hidden Snowboard", undefined)).toBeNull();
  });

  it("strips a repeated product name from the variant option", () => {
    const p = "Selling Plans Ski Wax";
    expect(cleanVariantTitle(p, "Sample Selling Plans Ski Wax")).toBe("Sample");
    expect(cleanVariantTitle(p, "Special Selling Plans Ski Wax")).toBe("Special");
  });

  it("returns null when the variant option IS the product name", () => {
    expect(cleanVariantTitle("Selling Plans Ski Wax", "Selling Plans Ski Wax")).toBeNull();
  });

  it("keeps a genuine variant option untouched", () => {
    expect(cleanVariantTitle("T-Shirt", "Red / Large")).toBe("Red / Large");
  });
});

describe("buildSkuTitle", () => {
  it("uses the product name alone for single-variant products", () => {
    expect(buildSkuTitle("The Hidden Snowboard", "Default Title")).toBe("The Hidden Snowboard");
  });

  it("does not double the product name (Shopify sample variants)", () => {
    expect(buildSkuTitle("Selling Plans Ski Wax", "Sample Selling Plans Ski Wax")).toBe(
      "Selling Plans Ski Wax — Sample",
    );
    // Variant option equals the product name → no distinguishing suffix.
    expect(buildSkuTitle("Selling Plans Ski Wax", "Selling Plans Ski Wax")).toBe(
      "Selling Plans Ski Wax",
    );
  });

  it("combines product and a genuine variant", () => {
    expect(buildSkuTitle("T-Shirt", "Red / Large")).toBe("T-Shirt — Red / Large");
  });
});

describe("splitSkuTitle", () => {
  it("returns product-only for single-variant titles", () => {
    expect(splitSkuTitle("The Hidden Snowboard")).toEqual({
      product: "The Hidden Snowboard",
      variant: null,
    });
  });

  it("splits a clean combined title", () => {
    expect(splitSkuTitle("T-Shirt — Red / Large")).toEqual({
      product: "T-Shirt",
      variant: "Red / Large",
    });
  });

  it("dedupes a legacy doubled title (pre-reingest data)", () => {
    expect(splitSkuTitle("Selling Plans Ski Wax — Sample Selling Plans Ski Wax")).toEqual({
      product: "Selling Plans Ski Wax",
      variant: "Sample",
    });
    expect(splitSkuTitle("Selling Plans Ski Wax — Selling Plans Ski Wax")).toEqual({
      product: "Selling Plans Ski Wax",
      variant: null,
    });
  });
});

describe("buildSkuTitle → splitSkuTitle round-trip", () => {
  it("recovers the deduped variant the mapper stored", () => {
    const built = buildSkuTitle("Selling Plans Ski Wax", "Sample Selling Plans Ski Wax");
    expect(splitSkuTitle(built)).toEqual({ product: "Selling Plans Ski Wax", variant: "Sample" });
  });
});
