import { describe, it, expect } from "vitest";
import { assembleParcels } from "../parcel";
import type { ShippingQuoteLine } from "../quote";

describe("assembleParcels (single-parcel-by-weight, v1)", () => {
  it("collapses lines into ONE parcel summing weightOz * quantity", () => {
    const cart: ShippingQuoteLine[] = [
      { variantId: "a", quantity: 2, weightOz: 8, lengthIn: 4, widthIn: 3, heightIn: 2 },
      { variantId: "b", quantity: 1, weightOz: 16, lengthIn: 6, widthIn: 2, heightIn: 5 },
    ];
    const { parcels, lowConfidence } = assembleParcels(cart);
    expect(parcels).toHaveLength(1);
    expect(parcels[0].weightOz).toBe(2 * 8 + 16); // 32
    expect(lowConfidence).toBe(false);
  });

  it("uses max-per-axis dims across the lines that provide them (single-box estimate)", () => {
    const { parcels } = assembleParcels([
      { variantId: "a", quantity: 1, weightOz: 8, lengthIn: 4, widthIn: 3, heightIn: 2 },
      { variantId: "b", quantity: 1, weightOz: 8, lengthIn: 6, widthIn: 2, heightIn: 5 },
    ]);
    expect(parcels[0]).toMatchObject({ lengthIn: 6, widthIn: 3, heightIn: 5 });
  });

  it("flags low confidence and zeroes dims when a line is missing dims", () => {
    const { parcels, lowConfidence } = assembleParcels([
      { variantId: "a", quantity: 3, weightOz: 4 }, // no dims
    ]);
    expect(lowConfidence).toBe(true);
    expect(parcels[0].weightOz).toBe(12);
    expect(parcels[0]).toMatchObject({ lengthIn: 0, widthIn: 0, heightIn: 0 });
  });

  it("flags low confidence when a line is missing weight", () => {
    const { lowConfidence } = assembleParcels([
      { variantId: "a", quantity: 1, lengthIn: 4, widthIn: 3, heightIn: 2 },
    ]);
    expect(lowConfidence).toBe(true);
  });
});
