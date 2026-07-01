// updateProduct must not touch the option-value links of a variant id it does not
// own. variant_option_value has no shop column, so the only guard is: the variant
// UPDATE (shop+product+id scoped) must have matched a row before its links are
// deleted/rewritten. A crafted variants[].id belonging to another shop matches 0
// rows and must be skipped, not have its links cross-tenant-deleted.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: vi.fn() }));

let variantMatched = false; // false => the variant id is foreign (UPDATE matches 0 rows)
const vovDelete = vi.fn(() => Promise.resolve({ error: null }));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const selectResult =
        table === "variant_dim"
          ? { data: variantMatched ? [{ id: "v1" }] : [], error: null }
          : { data: [{ id: "p1" }], error: null }; // product_dim parent UPDATE matches
      const chain: Record<string, unknown> = {
        eq: () => chain,
        notIn: () => Promise.resolve({ error: null }),
        in: () => Promise.resolve({ data: [], error: null }),
        select: () => Promise.resolve(selectResult),
        then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r),
      };
      return {
        update: () => chain,
        delete: () => (table === "variant_option_value" ? { eq: vovDelete } : chain),
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: "x" }, error: null }) }) }),
        upsert: () => Promise.resolve({ error: null }),
        select: () => chain,
      };
    },
  }),
}));

beforeEach(() => {
  variantMatched = false;
  vovDelete.mockClear();
});

describe("updateProduct variant scoping", () => {
  it("does NOT rebuild links for a foreign variant id (UPDATE matched 0 rows)", async () => {
    const { updateProduct } = await import("../catalog.server");
    await updateProduct("shop1", "p1", {
      title: "T", status: "active", options: [], collectionIds: [],
      variants: [{ id: "foreign-v", sku: "s" }],
    });
    expect(vovDelete).not.toHaveBeenCalled();
  });

  it("rebuilds links for an owned variant id (UPDATE matched a row)", async () => {
    variantMatched = true;
    const { updateProduct } = await import("../catalog.server");
    await updateProduct("shop1", "p1", {
      title: "T", status: "active", options: [], collectionIds: [],
      variants: [{ id: "v1", sku: "s" }],
    });
    expect(vovDelete).toHaveBeenCalledWith("variant_id", "v1");
  });
});
