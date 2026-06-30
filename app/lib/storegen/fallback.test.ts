// app/lib/storegen/fallback.test.ts
import { describe, it, expect } from "vitest";
import { fallbackDoc } from "./fallback";
import { validateDocument } from "~/lib/storebuilder/validate";

const valid = { productIds: new Set<string>(), collectionHandles: new Set<string>() };

describe("fallbackDoc", () => {
  it("home → hero + all-products grid (no specific ids), validates clean", () => {
    const doc = fallbackDoc("home", { storeName: "Acme", tagline: "Go" });
    expect(doc.blocks.map((b) => b.type)).toEqual(["hero", "productGrid"]);
    expect(validateDocument(doc, valid).dropped).toHaveLength(0);
  });
  it("pdp → gallery + price + variantPicker + addToCart (buy-path complete)", () => {
    const doc = fallbackDoc("pdp", { storeName: "Acme", tagline: "" });
    const types = doc.blocks.map((b) => b.type);
    for (const t of ["productGallery", "price", "variantPicker", "addToCart"]) expect(types).toContain(t);
    expect(validateDocument(doc, valid).missingFunctional).toEqual([]);
  });
  it("collection → collectionGrid template", () => {
    const doc = fallbackDoc("collection", { storeName: "Acme", tagline: "" });
    expect(doc.kind).toBe("template");
    expect(doc.blocks.map((b) => b.type)).toContain("collectionGrid");
  });
});
