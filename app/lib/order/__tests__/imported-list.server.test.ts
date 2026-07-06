import { describe, it, expect } from "vitest";
import {
  buildImportedOrdersPage,
  type RawImportedOrder,
  type RawImportedRefund,
} from "../imported-list.server";

function order(over: Partial<RawImportedOrder> = {}): RawImportedOrder {
  return {
    id: "o1",
    order_number: "#1001",
    external_id: "gid://shopify/Order/1001",
    financial_status: "PAID",
    currency: "USD",
    total_cents: 10000,
    processed_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

describe("buildImportedOrdersPage", () => {
  it("sums gross/refunded/net and rolls refunds up per order", () => {
    const orders = [
      order({ id: "o1", total_cents: 10000, processed_at: "2026-06-01T00:00:00Z" }),
      order({ id: "o2", total_cents: 5000, processed_at: "2026-06-02T00:00:00Z" }),
      order({ id: "o3", total_cents: 8000, processed_at: "2026-06-03T00:00:00Z" }),
    ];
    const refunds: RawImportedRefund[] = [
      { imported_order_id: "o1", subtotal_cents: 2500 },
      { imported_order_id: "o3", subtotal_cents: 5000 },
      { imported_order_id: "o3", subtotal_cents: 3000 },
    ];
    const page = buildImportedOrdersPage(orders, refunds, 500);

    expect(page.summary.orderCount).toBe(3);
    expect(page.summary.grossCents).toBe(23000);
    expect(page.summary.refundedCents).toBe(10500);
    expect(page.summary.refundCount).toBe(3);
    expect(page.summary.netCents).toBe(12500);

    const byId = Object.fromEntries(page.orders.map((r) => [r.id, r.refundedCents]));
    expect(byId.o1).toBe(2500);
    expect(byId.o2).toBe(0);
    expect(byId.o3).toBe(8000);
  });

  it("orders newest-first and reports the date span", () => {
    const orders = [
      order({ id: "old", processed_at: "2026-03-25T00:00:00Z" }),
      order({ id: "new", processed_at: "2026-06-22T00:00:00Z" }),
      order({ id: "mid", processed_at: "2026-05-01T00:00:00Z" }),
    ];
    const page = buildImportedOrdersPage(orders, [], 500);
    expect(page.orders.map((r) => r.id)).toEqual(["new", "mid", "old"]);
    expect(page.summary.firstOrderAt).toBe("2026-03-25T00:00:00.000Z");
    expect(page.summary.lastOrderAt).toBe("2026-06-22T00:00:00.000Z");
  });

  it("caps the table at recentLimit but keeps the true total in the summary", () => {
    const orders = Array.from({ length: 5 }, (_, i) =>
      order({ id: `o${i}`, processed_at: `2026-06-0${i + 1}T00:00:00Z`, total_cents: 100 }),
    );
    const page = buildImportedOrdersPage(orders, [], 2);
    expect(page.totalCount).toBe(5);
    expect(page.shownCount).toBe(2);
    expect(page.orders).toHaveLength(2);
    // summary still spans all five (5 * 100)
    expect(page.summary.grossCents).toBe(500);
    // and the two shown are the most recent
    expect(page.orders.map((r) => r.id)).toEqual(["o4", "o3"]);
  });

  it("falls back to a short id ref and lowercases status", () => {
    const page = buildImportedOrdersPage(
      [order({ id: "x", order_number: null, external_id: "gid://shopify/Order/98765", financial_status: "PARTIALLY_REFUNDED" })],
      [],
      500,
    );
    expect(page.orders[0].ref).toBe("#98765");
    expect(page.orders[0].financialStatus).toBe("partially_refunded");
  });

  it("handles an empty import with a zeroed summary and USD default", () => {
    const page = buildImportedOrdersPage([], [], 500);
    expect(page.summary).toMatchObject({
      orderCount: 0,
      grossCents: 0,
      refundedCents: 0,
      refundCount: 0,
      netCents: 0,
      currency: "USD",
      firstOrderAt: null,
      lastOrderAt: null,
    });
    expect(page.orders).toEqual([]);
    expect(page.totalCount).toBe(0);
  });

  it("excludes an orphan refund (order outside the window, null link) so Gross/Refunded/Net stay one population", () => {
    const page = buildImportedOrdersPage(
      [order({ id: "o1", total_cents: 10000 })],
      [
        { imported_order_id: "o1", subtotal_cents: 1000 },
        { imported_order_id: null, subtotal_cents: 500 },
      ],
      500,
    );
    expect(page.summary.refundedCents).toBe(1000); // orphan 500 excluded
    expect(page.summary.refundCount).toBe(1);
    expect(page.summary.netCents).toBe(9000); // 10000 - 1000, coherent
    expect(page.orders[0].refundedCents).toBe(1000);
  });
});
