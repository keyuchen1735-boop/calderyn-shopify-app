import { describe, expect, it } from "vitest";
import { reduceLineRefundPreview } from "../reduce-line-preview";

describe("reduceLineRefundPreview", () => {
  it("prorates the order's tax by this reduction's share of subtotal (mirrors edit.server.ts's fixture: 10000/800, reduce 2500 subtotal -> 200 tax, refund 2700)", () => {
    expect(
      reduceLineRefundPreview({
        unitPriceCents: 1250,
        currentQuantity: 5,
        newQuantity: 3,
        orderSubtotalCents: 10000,
        orderTaxCents: 800,
      }),
    ).toEqual({ deltaQuantity: 2, deltaSubtotalCents: 2500, taxShareCents: 200, refundCents: 2700 });
  });

  it("floors the tax share rather than rounding", () => {
    // deltaSubtotal 999, tax 100 over subtotal 3000 -> 999*100/3000 = 33.3 -> floors to 33
    expect(
      reduceLineRefundPreview({
        unitPriceCents: 999,
        currentQuantity: 4,
        newQuantity: 3,
        orderSubtotalCents: 3000,
        orderTaxCents: 100,
      }),
    ).toEqual({ deltaQuantity: 1, deltaSubtotalCents: 999, taxShareCents: 33, refundCents: 1032 });
  });

  it("skips the tax prorate on a zero-subtotal order rather than dividing by zero", () => {
    expect(
      reduceLineRefundPreview({
        unitPriceCents: 500,
        currentQuantity: 2,
        newQuantity: 1,
        orderSubtotalCents: 0,
        orderTaxCents: 0,
      }),
    ).toEqual({ deltaQuantity: 1, deltaSubtotalCents: 500, taxShareCents: 0, refundCents: 500 });
  });

  it("reports zero delta when new quantity is not actually a reduction", () => {
    expect(
      reduceLineRefundPreview({
        unitPriceCents: 500,
        currentQuantity: 3,
        newQuantity: 3,
        orderSubtotalCents: 1500,
        orderTaxCents: 120,
      }),
    ).toEqual({ deltaQuantity: 0, deltaSubtotalCents: 0, taxShareCents: 0, refundCents: 0 });
  });
});
