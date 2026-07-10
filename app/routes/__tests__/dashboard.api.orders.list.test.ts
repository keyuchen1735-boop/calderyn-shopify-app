// Route tests for the unified orders list (Phase 2 Task 2): query-string validation + param
// passthrough to listOrdersUnified (mocked — the RPC wrapper has its own unit tests in
// unified-list.server.test.ts), following dashboard.api.orders.detail.test.ts's session.server
// mock convention.
import { describe, it, expect, vi, beforeEach } from "vitest";

const SESSION = {
  shopId: "shop-1",
  shopDomain: null,
  userId: "u1",
  sessionId: "s1",
  emailVerified: true,
  onboardedAt: null,
  accountCreatedAt: null,
};

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: vi.fn().mockResolvedValue(SESSION),
}));

const listOrdersUnified = vi.fn();
vi.mock("~/lib/order/unified-list.server", () => ({
  listOrdersUnified: (...a: unknown[]) => listOrdersUnified(...a),
}));

const ORIGIN = "https://calderyncompany.com";
const URL_BASE = `${ORIGIN}/dashboard/api/orders/list`;

const SAMPLE_ROW = {
  source: "calderyn" as const,
  id: "order-1",
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
  tags: ["vip"],
  remainingRefundableCents: 9999,
};

function get(query: string): Request {
  return new Request(`${URL_BASE}${query}`);
}

beforeEach(() => {
  listOrdersUnified.mockReset();
  listOrdersUnified.mockResolvedValue({ rows: [SAMPLE_ROW], totalCount: 1, offset: 0, limit: 50 });
});

describe("GET /dashboard/api/orders/list", () => {
  it("happy path: calls the wrapper with no params and maps rows to snake_case", async () => {
    const { loader } = await import("../dashboard.api.orders.list");
    const res = (await loader({ request: get("") } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rows: [
        {
          source: "calderyn",
          id: "order-1",
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
          tags: ["vip"],
          remaining_refundable_cents: 9999,
        },
      ],
      total_count: 1,
      offset: 0,
      limit: 50,
    });
    expect(listOrdersUnified).toHaveBeenCalledWith("shop-1", {});
  });

  it("passes through every filter param, splitting comma-separated payment_status", async () => {
    const { loader } = await import("../dashboard.api.orders.list");
    await loader({
      request: get(
        "?search=vip&payment_status=paid,partially_refunded&fulfillment_status=unfulfilled&source=calderyn" +
          "&date_from=2026-01-01T00:00:00Z&date_to=2026-01-31T23:59:59Z&tag=rush&archived=true" +
          "&sort=total&dir=asc&offset=10&limit=25",
      ),
    } as never);
    expect(listOrdersUnified).toHaveBeenCalledWith("shop-1", {
      search: "vip",
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
  });

  it("treats archived=1 as true", async () => {
    const { loader } = await import("../dashboard.api.orders.list");
    await loader({ request: get("?archived=1") } as never);
    expect(listOrdersUnified).toHaveBeenCalledWith("shop-1", { archived: true });
  });

  it("422s an invalid fulfillment_status without calling the wrapper", async () => {
    const { loader } = await import("../dashboard.api.orders.list");
    const res = (await loader({ request: get("?fulfillment_status=bogus") } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_fulfillment_status");
    expect(listOrdersUnified).not.toHaveBeenCalled();
  });

  it("422s an invalid source without calling the wrapper", async () => {
    const { loader } = await import("../dashboard.api.orders.list");
    const res = (await loader({ request: get("?source=bogus") } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_source");
    expect(listOrdersUnified).not.toHaveBeenCalled();
  });

  it("422s an unparseable date_from without calling the wrapper", async () => {
    const { loader } = await import("../dashboard.api.orders.list");
    const res = (await loader({ request: get("?date_from=not-a-date") } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_date");
    expect(listOrdersUnified).not.toHaveBeenCalled();
  });

  it("422s an unparseable date_to without calling the wrapper", async () => {
    const { loader } = await import("../dashboard.api.orders.list");
    const res = (await loader({ request: get("?date_to=nope") } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_date");
    expect(listOrdersUnified).not.toHaveBeenCalled();
  });

  it("422s an invalid sort without calling the wrapper", async () => {
    const { loader } = await import("../dashboard.api.orders.list");
    const res = (await loader({ request: get("?sort=bogus") } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_sort");
    expect(listOrdersUnified).not.toHaveBeenCalled();
  });

  it("ignores an invalid dir rather than erroring", async () => {
    const { loader } = await import("../dashboard.api.orders.list");
    const res = (await loader({ request: get("?dir=sideways") } as never)) as Response;
    expect(res.status).toBe(200);
    expect(listOrdersUnified).toHaveBeenCalledWith("shop-1", {});
  });

  it("clamps limit above 100 down to 100 (no error)", async () => {
    const { loader } = await import("../dashboard.api.orders.list");
    const res = (await loader({ request: get("?limit=5000") } as never)) as Response;
    expect(res.status).toBe(200);
    expect(listOrdersUnified).toHaveBeenCalledWith("shop-1", { limit: 100 });
  });

  it("clamps limit below 1 up to 1 (no error)", async () => {
    const { loader } = await import("../dashboard.api.orders.list");
    await loader({ request: get("?limit=0") } as never);
    expect(listOrdersUnified).toHaveBeenCalledWith("shop-1", { limit: 1 });
  });

  it("ignores a negative offset rather than erroring", async () => {
    const { loader } = await import("../dashboard.api.orders.list");
    const res = (await loader({ request: get("?offset=-5") } as never)) as Response;
    expect(res.status).toBe(200);
    expect(listOrdersUnified).toHaveBeenCalledWith("shop-1", {});
  });
});
