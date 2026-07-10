import { describe, expect, it } from "vitest";
import {
  anyLineReturnable,
  defaultReturnRefundCents,
  hasOpenReturn,
  returnableQuantity,
  returnedQuantityForLine,
} from "../return-preview";
import { REDUCTION_TAX_FIXTURE } from "~/lib/order/__tests__/reduction-tax-fixture";
import type { OrderReturn } from "~/lib/order/returns-types";

function makeReturn(overrides: Partial<OrderReturn> & { lines: OrderReturn["lines"] }): OrderReturn {
  return {
    id: "ret-1",
    orderId: "order-1",
    status: "open",
    reason: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    receivedAt: null,
    ...overrides,
  };
}

describe("returnedQuantityForLine / returnableQuantity", () => {
  it("counts a CLOSED return's lines against the line's returnable quantity", () => {
    const returns = [
      makeReturn({ id: "r1", status: "closed", lines: [{ id: "rl1", orderLineId: "line-1", quantity: 2, restock: true, refundCents: 2000 }] }),
    ];
    expect(returnedQuantityForLine("line-1", returns)).toBe(2);
    expect(returnableQuantity({ id: "line-1", fulfilledQuantity: 5 }, returns)).toBe(3);
  });

  it("counts a RECEIVED return's lines the same as closed", () => {
    const returns = [
      makeReturn({ id: "r1", status: "received", lines: [{ id: "rl1", orderLineId: "line-1", quantity: 1, restock: true, refundCents: 1000 }] }),
    ];
    expect(returnableQuantity({ id: "line-1", fulfilledQuantity: 4 }, returns)).toBe(3);
  });

  it("ignores an OPEN return's lines (not yet completed)", () => {
    const returns = [
      makeReturn({ id: "r1", status: "open", lines: [{ id: "rl1", orderLineId: "line-1", quantity: 2, restock: true, refundCents: 2000 }] }),
    ];
    expect(returnableQuantity({ id: "line-1", fulfilledQuantity: 5 }, returns)).toBe(5);
  });

  it("ignores a CANCELLED return's lines", () => {
    const returns = [
      makeReturn({ id: "r1", status: "cancelled", lines: [{ id: "rl1", orderLineId: "line-1", quantity: 2, restock: true, refundCents: 2000 }] }),
    ];
    expect(returnableQuantity({ id: "line-1", fulfilledQuantity: 5 }, returns)).toBe(5);
  });

  it("sums across multiple completed returns on the same line", () => {
    const returns = [
      makeReturn({ id: "r1", status: "closed", lines: [{ id: "rl1", orderLineId: "line-1", quantity: 2, restock: true, refundCents: 1000 }] }),
      makeReturn({ id: "r2", status: "closed", lines: [{ id: "rl2", orderLineId: "line-1", quantity: 1, restock: true, refundCents: 500 }] }),
    ];
    expect(returnableQuantity({ id: "line-1", fulfilledQuantity: 5 }, returns)).toBe(2);
  });

  it("never returns negative even if returns somehow exceed fulfilled", () => {
    const returns = [
      makeReturn({ id: "r1", status: "closed", lines: [{ id: "rl1", orderLineId: "line-1", quantity: 10, restock: true, refundCents: 1000 }] }),
    ];
    expect(returnableQuantity({ id: "line-1", fulfilledQuantity: 5 }, returns)).toBe(0);
  });
});

describe("anyLineReturnable / hasOpenReturn", () => {
  it("is false when no line has returnable quantity", () => {
    const returns: OrderReturn[] = [];
    expect(anyLineReturnable([{ id: "l1", fulfilledQuantity: 0 }], returns)).toBe(false);
  });

  it("is true when at least one line has returnable quantity", () => {
    const returns: OrderReturn[] = [];
    expect(anyLineReturnable([{ id: "l1", fulfilledQuantity: 0 }, { id: "l2", fulfilledQuantity: 2 }], returns)).toBe(true);
  });

  it("hasOpenReturn is true only when a return is status 'open'", () => {
    expect(hasOpenReturn([makeReturn({ status: "closed", lines: [] })])).toBe(false);
    expect(hasOpenReturn([makeReturn({ status: "open", lines: [] })])).toBe(true);
  });
});

describe("defaultReturnRefundCents", () => {
  it("matches the shared reduction-tax fixture (unit price x qty + proportional tax share)", () => {
    expect(
      defaultReturnRefundCents({
        unitPriceCents: REDUCTION_TAX_FIXTURE.deltaSubtotal / 2, // 1250
        quantity: 2,
        orderSubtotalCents: REDUCTION_TAX_FIXTURE.subtotalCents,
        orderTaxCents: REDUCTION_TAX_FIXTURE.taxCents,
      }),
    ).toBe(REDUCTION_TAX_FIXTURE.expectedRefund);
  });

  it("skips the tax prorate on a zero-subtotal order rather than dividing by zero", () => {
    expect(
      defaultReturnRefundCents({ unitPriceCents: 500, quantity: 2, orderSubtotalCents: 0, orderTaxCents: 0 }),
    ).toBe(1000);
  });
});
