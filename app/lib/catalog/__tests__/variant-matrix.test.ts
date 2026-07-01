// buildVariantMatrix turns the editor's option definitions into the variant
// grid (the cartesian product of option values), carrying forward the SKU/price/
// stock of any prior variant whose option combination still exists. It is the one
// non-trivial bit of editor logic, so it is a pure, unit-tested function.

import { describe, it, expect } from "vitest";
import { buildVariantMatrix } from "../variant-matrix";

describe("buildVariantMatrix", () => {
  it("returns a single default variant when there are no options", () => {
    const out = buildVariantMatrix([], [{ sku: "BASE", retailPriceCents: 1999 }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(expect.objectContaining({ sku: "BASE", retailPriceCents: 1999, optionValues: [] }));
  });

  it("builds the cartesian product of two options in option order", () => {
    const out = buildVariantMatrix(
      [{ name: "Size", values: ["S", "M"] }, { name: "Color", values: ["Red"] }],
      [],
    );
    expect(out.map((v) => v.optionValues)).toEqual([["S", "Red"], ["M", "Red"]]);
  });

  it("preserves an existing variant's data by matching its option values", () => {
    const out = buildVariantMatrix(
      [{ name: "Size", values: ["S", "M"] }],
      [{ sku: "OLD-M", retailPriceCents: 5, optionValues: ["M"] }],
    );
    const m = out.find((v) => v.optionValues?.[0] === "M");
    expect(m).toEqual(expect.objectContaining({ sku: "OLD-M", retailPriceCents: 5 }));
    const s = out.find((v) => v.optionValues?.[0] === "S");
    expect(s?.sku).toBeUndefined();
  });

  it("ignores half-finished options (no name, or no values yet)", () => {
    const out = buildVariantMatrix(
      [{ name: "", values: ["S"] }, { name: "Size", values: [] }],
      [{ sku: "BASE" }],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(expect.objectContaining({ sku: "BASE", optionValues: [] }));
  });

  it("drops data for a combination that no longer exists", () => {
    const out = buildVariantMatrix(
      [{ name: "Size", values: ["S", "M"] }],
      [{ sku: "GONE", optionValues: ["XL"] }],
    );
    expect(out).toHaveLength(2);
    expect(out.some((v) => v.sku === "GONE")).toBe(false);
  });

  // The variant id is the load-bearing identity (variant_dim.id == sku_dim.id).
  // A label-keyed matrix cannot tell a RENAME from a REMOVE+ADD, so an unmatched
  // combination must be a NEW id-less variant - never inherit an order-linked id,
  // which would silently reassign that variant's history to a different product.
  it("treats a renamed option value as a new id-less variant (no id/data reuse)", () => {
    const out = buildVariantMatrix(
      [{ name: "Size", values: ["Medium"] }],
      [{ id: "var-m", sku: "TEE-M", retailPriceCents: 1999, optionValues: ["M"] }],
    );
    expect(out).toHaveLength(1);
    expect(out[0].optionValues).toEqual(["Medium"]);
    expect(out[0].id).toBeUndefined();
    expect(out[0].sku).toBeUndefined();
  });

  it("does NOT reattach a removed variant's id on a remove+add in one edit", () => {
    // Merchant replaces Size values "S, M" with "S, L" in one change: S keeps its
    // id, L is brand-new, and var-m must not be silently reassigned to L.
    const out = buildVariantMatrix(
      [{ name: "Size", values: ["S", "L"] }],
      [
        { id: "var-s", optionValues: ["S"] },
        { id: "var-m", optionValues: ["M"] },
      ],
    );
    expect(out.find((v) => v.optionValues?.[0] === "S")?.id).toBe("var-s");
    expect(out.find((v) => v.optionValues?.[0] === "L")?.id).toBeUndefined();
    expect(out.some((v) => v.id === "var-m")).toBe(false);
  });

  it("keeps all id-bearing variants when every option is cleared", () => {
    const out = buildVariantMatrix(
      [],
      [
        { id: "var-s", sku: "S", optionValues: ["S"] },
        { id: "var-m", sku: "M", optionValues: ["M"] },
      ],
    );
    expect(out.map((v) => v.id).sort()).toEqual(["var-m", "var-s"]);
    expect(out.every((v) => (v.optionValues ?? []).length === 0)).toBe(true);
  });

  it("still drops a removed value's variant (intended removal keeps the rest by id)", () => {
    const out = buildVariantMatrix(
      [{ name: "Size", values: ["S", "L"] }],
      [
        { id: "var-s", optionValues: ["S"] },
        { id: "var-m", optionValues: ["M"] },
        { id: "var-l", optionValues: ["L"] },
      ],
    );
    expect(out.map((v) => v.id).sort()).toEqual(["var-l", "var-s"]);
    expect(out.some((v) => v.id === "var-m")).toBe(false);
  });
});
