import { describe, it, expect } from "vitest";
import { productIcon, phVars } from "./product-card";
import { Coffee, Shirt, Package } from "lucide-react";
import type { StoreProduct } from "~/lib/storefront/catalog";

const base: StoreProduct = { id: "p1", handle: "stoneware-mug", title: "Stoneware Pour-Over Mug", description: "Hand-glazed ceramic.", images: [], variants: [], collections: [] };

describe("productIcon", () => {
  it("prefers the seeded cd-icon: tag", () => {
    expect(productIcon({ ...base, tags: ["calderyn:sample", "cd-icon:shirt"] })).toBe(Shirt);
  });
  it("falls back to keyword match on title/description", () => {
    expect(productIcon(base)).toBe(Coffee); // "mug"
  });
  it("defaults to Package when nothing matches", () => {
    expect(productIcon({ ...base, handle: "x", title: "Mystery Object", description: "" })).toBe(Package);
  });
});

describe("phVars", () => {
  it("is deterministic per handle", () => {
    expect(phVars(base)).toEqual(phVars({ ...base }));
  });
  it("differs across handles and respects cd-tone", () => {
    const warm = phVars({ ...base, tags: ["cd-tone:warm"] });
    const cool = phVars({ ...base, tags: ["cd-tone:cool"] });
    expect(warm["--ph-hue"]).not.toBe(cool["--ph-hue"]);
    expect(phVars({ ...base, handle: "other-thing" })["--ph-angle"]).not.toBe(phVars(base)["--ph-angle"]);
  });
});
