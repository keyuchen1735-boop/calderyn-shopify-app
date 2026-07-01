import { describe, it, expect } from "vitest";
import { validateVariantDims, isShippingComplete, toParcelDims } from "../shipping-dims";

describe("validateVariantDims", () => {
  it("accepts positive integer metric values", () => {
    expect(validateVariantDims({ grams: 500, lengthMm: 200, widthMm: 150, heightMm: 100 })).toEqual({ ok: true });
  });
  it("treats missing fields as valid (presence-soft)", () => {
    expect(validateVariantDims({ grams: 500 })).toEqual({ ok: true });
    expect(validateVariantDims({})).toEqual({ ok: true });
  });
  it("rejects zero, negative, and non-integer values with the field name", () => {
    expect(validateVariantDims({ lengthMm: 0 })).toMatchObject({ ok: false, error: expect.stringContaining("lengthMm") });
    expect(validateVariantDims({ grams: -1 })).toMatchObject({ ok: false });
    expect(validateVariantDims({ widthMm: 1.5 })).toMatchObject({ ok: false, error: expect.stringContaining("widthMm") });
  });
  it("rejects values over the fat-finger ceiling", () => {
    expect(validateVariantDims({ heightMm: 3001 })).toMatchObject({ ok: false });
    expect(validateVariantDims({ grams: 2_000_001 })).toMatchObject({ ok: false });
  });
});

describe("isShippingComplete", () => {
  it("is false when a shippable variant misses any of weight/dims", () => {
    expect(isShippingComplete({ grams: 500, lengthMm: 200, widthMm: 150 })).toBe(false);
  });
  it("is true when weight and all dims are present", () => {
    expect(isShippingComplete({ grams: 500, lengthMm: 200, widthMm: 150, heightMm: 100 })).toBe(true);
  });
  it("is true (n/a) when the variant does not require shipping", () => {
    expect(isShippingComplete({ requiresShipping: false })).toBe(true);
  });
});

describe("toParcelDims", () => {
  it("converts mm to inches and grams to ounces (rounded to 2dp)", () => {
    expect(toParcelDims({ grams: 28, lengthMm: 254, widthMm: 254, heightMm: 254 })).toEqual({
      lengthIn: 10, widthIn: 10, heightIn: 10, weightOz: 0.99,
    });
  });
  it("passes missing metric fields through as null", () => {
    expect(toParcelDims({ grams: 28 })).toEqual({ lengthIn: null, widthIn: null, heightIn: null, weightOz: 0.99 });
  });
});
