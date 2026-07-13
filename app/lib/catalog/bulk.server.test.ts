import { describe, expect, it } from "vitest";
import { validateBulkProductIds, runBulkProductAction, MAX_BULK_PRODUCTS } from "./bulk.server";

describe("validateBulkProductIds", () => {
  it("accepts and dedupes string ids", () => {
    const r = validateBulkProductIds(["a", "b", "a"]);
    expect(r).toEqual({ ok: true, productIds: ["a", "b"] });
  });
  it("rejects non-arrays, empty arrays, and non-string members", () => {
    for (const bad of [null, "x", [], ["a", 3], [""]]) {
      expect(validateBulkProductIds(bad).ok).toBe(false);
    }
  });
  it("rejects more than MAX_BULK_PRODUCTS after dedupe", () => {
    const ids = Array.from({ length: MAX_BULK_PRODUCTS + 1 }, (_, i) => `p${i}`);
    const r = validateBulkProductIds(ids);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("too_many_products");
  });
});

describe("runBulkProductAction", () => {
  it("returns per-product outcomes and downgrades rejections", async () => {
    const results = await runBulkProductAction(["a", "b"], async (id) => {
      if (id === "b") throw new Error("boom");
    });
    expect(results).toEqual([
      { product_id: "a", ok: true },
      { product_id: "b", ok: false, error: "Something went wrong." },
    ]);
  });
});
