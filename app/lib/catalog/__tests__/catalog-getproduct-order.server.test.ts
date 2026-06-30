// getProduct must return option values and each variant's optionValueIds in a
// DETERMINISTIC option order. PostgREST returns the variant_option_value link
// rows (and embedded option values) in an undefined order, and the editor's
// buildVariantMatrix keys variants by the ORDERED label array - so a scrambled
// order would make an option edit fail to match an existing variant and drop its
// id, breaking variant_dim.id == sku_dim.id. These lock the ordering.

import { describe, it, expect, vi } from "vitest";

const productSingle = {
  data: { id: "p1", title: "Tee", status: "active", vendor: null, category: null, description: null, tags: [], updated_at: "t" },
  error: null,
};
// product_option ordered by position (Size, then Color); each option's embedded
// values are returned in a SCRAMBLED position order on purpose.
const optionRows = {
  data: [
    { id: "oSize", name: "Size", position: 0, product_option_value: [
      { id: "vM", value: "M", position: 1 },
      { id: "vS", value: "S", position: 0 },
    ] },
    { id: "oColor", name: "Color", position: 1, product_option_value: [
      { id: "vRed", value: "Red", position: 0 },
    ] },
  ],
  error: null,
};
const variantRows = {
  data: [
    { id: "var1", sku: "X", title: "S/Red", retail_price_cents: 1000, unit_cost_cents: null, inventory_tracked: null, inventory_on_hand: 2, position: 0 },
  ],
  error: null,
};
// Link rows in the WRONG order (Color before Size).
const vovRows = {
  data: [
    { variant_id: "var1", option_value_id: "vRed" },
    { variant_id: "var1", option_value_id: "vS" },
  ],
  error: null,
};
const mediaRows = { data: [], error: null };
const pcRows = { data: [], error: null };

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "product_dim") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(productSingle) }) }) }) };
      }
      if (table === "product_option") {
        return { select: () => ({ eq: () => ({ order: () => Promise.resolve(optionRows) }) }) };
      }
      if (table === "variant_dim") {
        return { select: () => ({ eq: () => ({ order: () => Promise.resolve(variantRows) }) }) };
      }
      if (table === "variant_option_value") {
        return { select: () => Promise.resolve(vovRows) };
      }
      if (table === "product_media") {
        return { select: () => ({ eq: () => ({ order: () => Promise.resolve(mediaRows) }) }) };
      }
      return { select: () => ({ eq: () => Promise.resolve(pcRows) }) }; // product_collection
    },
  }),
}));

describe("getProduct option ordering", () => {
  it("returns option values in position order even when rows are scrambled", async () => {
    const { getProduct } = await import("../catalog.server");
    const p = await getProduct("shop1", "p1");
    expect(p?.options[0].values.map((v) => v.value)).toEqual(["S", "M"]);
  });

  it("returns each variant's optionValueIds in option order, not row order", async () => {
    const { getProduct } = await import("../catalog.server");
    const p = await getProduct("shop1", "p1");
    // Size value (vS) before Color value (vRed), despite the link rows being [vRed, vS].
    expect(p?.variants[0].optionValueIds).toEqual(["vS", "vRed"]);
  });
});
