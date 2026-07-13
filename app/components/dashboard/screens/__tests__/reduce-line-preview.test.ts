import { describe, expect, it } from "vitest";
import { reduceLineRefundPreview } from "../reduce-line-preview";
import { REDUCTION_TAX_FIXTURE } from "~/lib/order/__tests__/reduction-tax-fixture";

describe("reduceLineRefundPreview", () => {
  it("prorates the order's tax by this reduction's share of subtotal (shared fixture)", () => {
    expect(
      reduceLineRefundPreview({
        unitPriceCents: REDUCTION_TAX_FIXTURE.deltaSubtotal / 2, // 1250
        currentQuantity: 5,
        newQuantity: 3,
        orderSubtotalCents: REDUCTION_TAX_FIXTURE.subtotalCents,
        orderTaxCents: REDUCTION_TAX_FIXTURE.taxCents,
      }),
    ).toEqual({
      deltaQuantity: 2,
      deltaSubtotalCents: REDUCTION_TAX_FIXTURE.deltaSubtotal,
      taxShareCents: REDUCTION_TAX_FIXTURE.expectedTaxShare,
      refundCents: REDUCTION_TAX_FIXTURE.expectedRefund
    });
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
