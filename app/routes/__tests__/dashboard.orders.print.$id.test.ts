// Loader tests for the printable packing-slip/invoice page (Task 5). This is a
// full-page NON-SPA route opened via window.open (never the SPA router), so
// only the loader is exercised here — component rendering has no test harness
// in this repo (see task-5-brief.md). Mock shape mirrors
// dashboard.api.orders.detail.test.ts: session.server + order/detail.server mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";

const SESSION = {
  shopId: "shop-1",
  shopDomain: "peakandpine.calderyncompany.com",
  userId: "u1",
  sessionId: "s1",
  emailVerified: true,
  onboardedAt: null,
  accountCreatedAt: null,
};

const requireDashboardSession = vi.fn();
vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));

const loadOrderDetail = vi.fn();
vi.mock("~/lib/order/detail.server", () => ({
  loadOrderDetail: (...a: unknown[]) => loadOrderDetail(...a),
}));

const ORDER = {
  source: "calderyn",
  id: "order-1",
  ref: "#1042",
  createdAt: "2026-07-01T12:00:00.000Z",
  state: "paid",
  financialStatus: "paid",
  archivedAt: null,
  cancelledAt: null,
  cancelReason: null,
  channel: null,
  attribution: null,
  currency: "usd",
  subtotalCents: 1000,
  shippingCents: 500,
  taxCents: 100,
  discountCents: 0,
  totalCents: 1600,
  refundedCents: 0,
  remainingRefundableCents: 1600,
  buyer: { id: "b1", email: "buyer@example.com" },
  shippingAddress: {
    name: "Jane Buyer",
    line1: "1 Main St",
    line2: null,
    city: "Springfield",
    region: "IL",
    postal: "62701",
    country: "US",
  },
  lines: [{ id: "l1", title: "Widget", sku: "WID-1", quantity: 2, unitPriceCents: 500, fulfilledQuantity: 0 }],
  fulfillments: [],
  tags: [],
  timeline: [],
  readOnly: false,
};

function req(url: string): Request {
  return new Request(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireDashboardSession.mockResolvedValue(SESSION);
  loadOrderDetail.mockReset();
});

describe("GET /dashboard/orders/print/:id", () => {
  it("requires a dashboard session", async () => {
    requireDashboardSession.mockRejectedValue(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    const { loader } = await import("../dashboard.orders.print.$id");
    await expect(
      loader({ request: req("https://calderyncompany.com/dashboard/orders/print/order-1"), params: { id: "order-1" } } as never),
    ).rejects.toMatchObject({ status: 401 });
    expect(loadOrderDetail).not.toHaveBeenCalled();
  });

  it("422s an invalid doc query param without loading the order", async () => {
    const { loader } = await import("../dashboard.orders.print.$id");
    const res = (await loader({
      request: req("https://calderyncompany.com/dashboard/orders/print/order-1?doc=receipt"),
      params: { id: "order-1" },
    } as never).catch((e) => e)) as Response;
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_doc");
    expect(loadOrderDetail).not.toHaveBeenCalled();
  });

  it("404s an unknown order id", async () => {
    loadOrderDetail.mockResolvedValue(null);
    const { loader } = await import("../dashboard.orders.print.$id");
    const res = (await loader({
      request: req("https://calderyncompany.com/dashboard/orders/print/nope"),
      params: { id: "nope" },
    } as never).catch((e) => e)) as Response;
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(404);
    expect(loadOrderDetail).toHaveBeenCalledWith("shop-1", "nope");
  });

  it("defaults to a packing-slip doc and returns doc + order + shopLabel", async () => {
    loadOrderDetail.mockResolvedValue(ORDER);
    const { loader } = await import("../dashboard.orders.print.$id");
    const res = (await loader({
      request: req("https://calderyncompany.com/dashboard/orders/print/order-1"),
      params: { id: "order-1" },
    } as never)) as Response;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.doc).toBe("packing-slip");
    expect(body.shopLabel).toBe("peakandpine.calderyncompany.com");
    expect(body.order).toEqual(ORDER);
  });

  it("accepts an explicit doc=invoice", async () => {
    loadOrderDetail.mockResolvedValue(ORDER);
    const { loader } = await import("../dashboard.orders.print.$id");
    const res = (await loader({
      request: req("https://calderyncompany.com/dashboard/orders/print/order-1?doc=invoice"),
      params: { id: "order-1" },
    } as never)) as Response;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.doc).toBe("invoice");
  });

  it("falls back shopLabel to 'Order' when the session has no shopDomain", async () => {
    requireDashboardSession.mockResolvedValue({ ...SESSION, shopDomain: null });
    loadOrderDetail.mockResolvedValue(ORDER);
    const { loader } = await import("../dashboard.orders.print.$id");
    const res = (await loader({
      request: req("https://calderyncompany.com/dashboard/orders/print/order-1"),
      params: { id: "order-1" },
    } as never)) as Response;
    const body = await res.json();
    expect(body.shopLabel).toBe("Order");
  });
});
