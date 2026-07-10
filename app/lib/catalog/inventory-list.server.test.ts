import { describe, expect, it } from "vitest";
import { escapeLike, mapInventoryRow, restockKeyFromParams } from "./inventory-list.server";

describe("mapInventoryRow", () => {
  it("maps snake_case RPC output and null single_location_id", () => {
    const row = mapInventoryRow({
      variant_id: "v1", product_id: "p1", sku: "SKU-1", variant_title: "M / Red",
      product_title: "Tee", on_hand: 5, reserved: 2, incoming: 0, available: 3,
      low: true, location_count: 2, single_location_id: null, total_count: 41,
    });
    expect(row).toEqual({
      variantId: "v1", productId: "p1", sku: "SKU-1", variantTitle: "M / Red",
      productTitle: "Tee", onHand: 5, reserved: 2, incoming: 0, available: 3,
      low: true, locationCount: 2, singleLocationId: null, restock: null,
    });
  });
});

describe("escapeLike", () => {
  it("passes a plain term through unchanged", () => {
    expect(escapeLike("blue tee")).toBe("blue tee");
  });
  it("escapes the percent wildcard", () => {
    expect(escapeLike("100% cotton")).toBe("100\\% cotton");
  });
  it("escapes the underscore wildcard", () => {
    expect(escapeLike("SKU_1")).toBe("SKU\\_1");
  });
  it("escapes a literal backslash", () => {
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });
  it("escapes backslash before wildcards so mixed input stays literal", () => {
    expect(escapeLike("\\%_")).toBe("\\\\\\%\\_");
  });
});

describe("restockKeyFromParams", () => {
  it("extracts the first PO line sku", () => {
    expect(restockKeyFromParams({ po: { lines: [{ sku: "SKU-1" }] } })).toBe("SKU-1");
  });
  it("returns null when the snapshot is absent or malformed", () => {
    expect(restockKeyFromParams(null)).toBeNull();
    expect(restockKeyFromParams({})).toBeNull();
    expect(restockKeyFromParams({ po: { lines: [] } })).toBeNull();
  });
});
