// app/lib/storebuilder/registry.test.ts
import { describe, it, expect } from "vitest";
import { getBlockMeta, BLOCK_REGISTRY } from "./registry";

describe("block registry", () => {
  it("indexes all 11 blocks by type", () => {
    expect(Object.keys(BLOCK_REGISTRY).sort()).toEqual([
      "addToCart", "button", "collectionGrid", "collectionList", "hero",
      "image", "price", "productGallery", "productGrid", "richText", "variantPicker",
    ]);
  });
  it("getBlockMeta returns a functional block", () => {
    expect(getBlockMeta("addToCart")?.flavor).toBe("functional");
  });
  it("getBlockMeta returns the entry for a known type", () => {
    expect(getBlockMeta("hero")?.flavor).toBe("static");
  });
  it("getBlockMeta returns undefined for an unknown type (forward-compat)", () => {
    // @ts-expect-error intentionally invalid type
    expect(getBlockMeta("carousel")).toBeUndefined();
  });
});
