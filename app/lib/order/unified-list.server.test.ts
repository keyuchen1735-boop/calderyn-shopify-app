import { describe, it, expect, beforeEach, vi } from "vitest";

const store = vi.hoisted(() => {
  const rpc = vi.fn();
  return { rpc };
});

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    rpc: store.rpc,
  }),
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the supabase fake is registered first
import { listOrdersUnified } from "./unified-list.server";

beforeEach(() => {
  store.rpc.mockReset();
});

describe("listOrdersUnified", () => {
  it("maps RPC results to UnifiedOrderRow and computes totalCount from full_count of first row", async () => {
    const mockRow = {
      source: "calderyn",
      id: "ord-123",
      ref: "#ABC1234",
      buyer_email: "alice@example.com",
      total_cents: 9999,
      currency: "USD",
      payment_status: "paid",
      state: "fulfilled",
      cancelled_at: null,
      archived_at: null,
      occurred_at: "2026-01-15T10:00:00Z",
      item_count: 2,
      tags: ["vip", "repeat"],
      remaining_refundable_cents: 9999,
      full_count: 42, // Total matching rows across all pages
    };
    store.rpc.mockResolvedValue({ data: [mockRow], error: null });

    const result = await listOrdersUnified("shop-1", {
      sort: "date",
      dir: "desc",
      offset: 0,
      limit: 50,
    });

    expect(result).toEqual({
      rows: [
        {
          source: "calderyn",
          id: "ord-123",
          ref: "#ABC1234",
          buyerEmail: "alice@example.com",
          totalCents: 9999,
          currency: "USD",
          paymentStatus: "paid",
          state: "fulfilled",
          cancelledAt: null,
          archivedAt: null,
          occurredAt: "2026-01-15T10:00:00Z",
          itemCount: 2,
          tags: ["vip", "repeat"],
          remainingRefundableCents: 9999,
        },
      ],
      totalCount: 42,
      offset: 0,
      limit: 50,
    });
  });

  it("returns 0 totalCount on an empty result set", async () => {
    store.rpc.mockResolvedValue({ data: [], error: null });

    const result = await listOrdersUnified("shop-1", {});

    expect(result).toEqual({
      rows: [],
      totalCount: 0,
      offset: 0,
      limit: 50,
    });
  });

  it("maps optional string fields to null when they are null in the RPC result", async () => {
    const mockRow = {
      source: "shopify",
      id: "io-456",
      ref: "#XYZ9876",
      buyer_email: null,
      total_cents: 5000,
      currency: "USD",
      payment_status: "pending",
      state: "pending",
      cancelled_at: null,
      archived_at: null,
      occurred_at: "2026-01-10T12:00:00Z",
      item_count: 1,
      tags: [],
      remaining_refundable_cents: 0,
      full_count: 1,
    };
    store.rpc.mockResolvedValue({ data: [mockRow], error: null });

    const result = await listOrdersUnified("shop-1", {});

    expect(result.rows[0]).toEqual(
      expect.objectContaining({
        buyerEmail: null,
        cancelledAt: null,
        archivedAt: null,
        tags: [],
      }),
    );
  });

  it("maps params to RPC args: defaults and nulls", async () => {
    store.rpc.mockResolvedValue({ data: [], error: null });

    await listOrdersUnified("shop-1", {
      search: "order #123",
      paymentStatus: ["paid", "partially_refunded"],
      fulfillmentStatus: "unfulfilled",
      source: "calderyn",
      dateFrom: "2026-01-01T00:00:00Z",
      dateTo: "2026-01-31T23:59:59Z",
      tag: "rush",
      archived: true,
      sort: "total",
      dir: "asc",
      offset: 10,
      limit: 25,
    });

    expect(store.rpc).toHaveBeenCalledWith("list_orders_unified", {
      p_shop_id: "shop-1",
      p_search: "order #123",
      p_payment_status: ["paid", "partially_refunded"],
      p_fulfillment_status: "unfulfilled",
      p_source: "calderyn",
      p_date_from: "2026-01-01T00:00:00Z",
      p_date_to: "2026-01-31T23:59:59Z",
      p_tag: "rush",
      p_archived: true,
      p_sort: "total",
      p_dir: "asc",
      p_offset: 10,
      p_limit: 25,
    });
  });

  it("uses defaults when params are omitted: null, false, 'date', 'desc', 0, 50", async () => {
    store.rpc.mockResolvedValue({ data: [], error: null });

    await listOrdersUnified("shop-1", {});

    expect(store.rpc).toHaveBeenCalledWith("list_orders_unified", {
      p_shop_id: "shop-1",
      p_search: null,
      p_payment_status: null,
      p_fulfillment_status: null,
      p_source: null,
      p_date_from: null,
      p_date_to: null,
      p_tag: null,
      p_archived: false,
      p_sort: "date",
      p_dir: "desc",
      p_offset: 0,
      p_limit: 50,
    });
  });

  it("throws when shopId is empty", async () => {
    await expect(listOrdersUnified("", {})).rejects.toThrow("shopId is required");
    expect(store.rpc).not.toHaveBeenCalled();
  });

  it("surfaces RPC errors", async () => {
    const rpcError = { message: "connection timeout" };
    store.rpc.mockResolvedValue({ data: null, error: rpcError });

    await expect(listOrdersUnified("shop-1", {})).rejects.toEqual(rpcError);
  });

  it("maps multiple rows and computes totalCount from the first row's full_count", async () => {
    const rows = [
      { source: "calderyn", id: "o1", ref: "#A1", buyer_email: "a@test.com", total_cents: 100, currency: "USD", payment_status: "paid", state: "fulfilled", cancelled_at: null, archived_at: null, occurred_at: "2026-01-01T00:00:00Z", item_count: 1, tags: [], remaining_refundable_cents: 100, full_count: 150 },
      { source: "shopify", id: "o2", ref: "#B2", buyer_email: "b@test.com", total_cents: 200, currency: "USD", payment_status: "pending", state: "pending", cancelled_at: null, archived_at: null, occurred_at: "2026-01-02T00:00:00Z", item_count: 2, tags: ["tag1"], remaining_refundable_cents: 0, full_count: 150 },
    ];
    store.rpc.mockResolvedValue({ data: rows, error: null });

    const result = await listOrdersUnified("shop-1", { limit: 2 });

    expect(result.rows).toHaveLength(2);
    expect(result.totalCount).toBe(150); // From first row's full_count
    expect(result.rows[0].source).toBe("calderyn");
    expect(result.rows[1].source).toBe("shopify");
  });
});
