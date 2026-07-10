// Route tests for GET/POST /dashboard/api/orders/:id/returns (orders Phase 4, Task 2).
// Boundary validation + the native-only guard are asserted here; createOrderReturn/
// listOrderReturns's own domain behavior is unit-tested in returns.server.test.ts, so mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as HttpServer from "~/lib/dashboard/http.server";

const ORIGIN = "https://calderyncompany.com";

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
vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof HttpServer>()),
}));

const returns = vi.hoisted(() => ({ createOrderReturn: vi.fn(), listOrderReturns: vi.fn() }));
vi.mock("~/lib/order/returns.server", () => returns);

function req(url: string, method: string, body?: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

const ORDER_ID = "order-1";
const URL_ = `${ORIGIN}/dashboard/api/orders/${ORDER_ID}/returns`;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
  returns.createOrderReturn.mockResolvedValue({
    returnId: "ret-1",
    status: "open",
    lines: [{ id: "rl-1", orderLineId: "line-1", quantity: 1, restock: true, refundCents: 1999 }],
  });
  returns.listOrderReturns.mockResolvedValue([
    {
      id: "ret-1",
      orderId: ORDER_ID,
      status: "open",
      reason: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      receivedAt: null,
      lines: [{ id: "rl-1", orderLineId: "line-1", quantity: 1, restock: true, refundCents: 1999 }],
    },
  ]);
});

describe("GET /dashboard/api/orders/:id/returns", () => {
  it("lists returns for a native order", async () => {
    const { loader } = await import("../dashboard.api.orders.$id.returns");
    const res = (await loader({
      request: req(URL_, "GET"),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(returns.listOrderReturns).toHaveBeenCalledWith("shop-1", ORDER_ID);
    const body = await res.json();
    expect(body.returns).toEqual([
      {
        id: "ret-1",
        order_id: ORDER_ID,
        status: "open",
        reason: null,
        created_at: "2026-07-01T00:00:00.000Z",
        received_at: null,
        lines: [{ id: "rl-1", order_line_id: "line-1", quantity: 1, restock: true, refund_cents: 1999 }],
      },
    ]);
  });

  it("returns an empty list for an imported (shopify:) order without calling listOrderReturns", async () => {
    const { loader } = await import("../dashboard.api.orders.$id.returns");
    const res = (await loader({
      request: req(`${ORIGIN}/dashboard/api/orders/shopify:99/returns`, "GET"),
      params: { id: "shopify:99" },
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ returns: [] });
    expect(returns.listOrderReturns).not.toHaveBeenCalled();
  });
});

describe("POST /dashboard/api/orders/:id/returns", () => {
  it("creates a return for a valid body", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns");
    const res = (await action({
      request: req(URL_, "POST", {
        lines: [{ order_line_id: "line-1", quantity: 1, restock: true }],
        reason: "Buyer changed their mind",
      }),
      params: { id: ORDER_ID },
    } as never)) as Response;

    expect(res.status).toBe(200);
    expect(returns.createOrderReturn).toHaveBeenCalledWith("shop-1", {
      orderId: ORDER_ID,
      lines: [{ orderLineId: "line-1", quantity: 1, restock: true, refundCents: undefined }],
      reason: "Buyer changed their mind",
    });
    expect(await res.json()).toEqual({
      return_id: "ret-1",
      status: "open",
      lines: [{ id: "rl-1", order_line_id: "line-1", quantity: 1, restock: true, refund_cents: 1999 }],
    });
  });

  it("passes through a client-supplied refund_cents", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns");
    await action({
      request: req(URL_, "POST", { lines: [{ order_line_id: "line-1", quantity: 1, restock: true, refund_cents: 500 }] }),
      params: { id: ORDER_ID },
    } as never);
    expect(returns.createOrderReturn).toHaveBeenCalledWith("shop-1", {
      orderId: ORDER_ID,
      lines: [{ orderLineId: "line-1", quantity: 1, restock: true, refundCents: 500 }],
      reason: null,
    });
  });

  it("refuses an imported (shopify:) order id", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns");
    const res = (await action({
      request: req(`${ORIGIN}/dashboard/api/orders/shopify:99/returns`, "POST", {
        lines: [{ order_line_id: "line-1", quantity: 1, restock: true }],
      }),
      params: { id: "shopify:99" },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("imported_read_only");
    expect(returns.createOrderReturn).not.toHaveBeenCalled();
  });

  it("422s an empty lines array", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns");
    const res = (await action({
      request: req(URL_, "POST", { lines: [] }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_lines");
  });

  it("422s more than 50 lines", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns");
    const lines = Array.from({ length: 51 }, (_, i) => ({ order_line_id: `line-${i}`, quantity: 1, restock: true }));
    const res = (await action({
      request: req(URL_, "POST", { lines }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_lines");
    expect(returns.createOrderReturn).not.toHaveBeenCalled();
  });

  it("422s a non-integer quantity", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns");
    const res = (await action({
      request: req(URL_, "POST", { lines: [{ order_line_id: "line-1", quantity: 1.5, restock: true }] }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_lines");
  });

  it("422s a negative refund_cents", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns");
    const res = (await action({
      request: req(URL_, "POST", { lines: [{ order_line_id: "line-1", quantity: 1, restock: true, refund_cents: -1 }] }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_lines");
  });

  it("422s a non-boolean restock", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns");
    const res = (await action({
      request: req(URL_, "POST", { lines: [{ order_line_id: "line-1", quantity: 1, restock: "yes" }] }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_lines");
  });

  it("422s a reason longer than 500 characters", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns");
    const res = (await action({
      request: req(URL_, "POST", {
        lines: [{ order_line_id: "line-1", quantity: 1, restock: true }],
        reason: "x".repeat(501),
      }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_reason");
    expect(returns.createOrderReturn).not.toHaveBeenCalled();
  });

  it("surfaces a CalderynError's status/code from the executor (e.g. over-cap refund)", async () => {
    const { CalderynError } = await import("~/lib/calderyn.server");
    returns.createOrderReturn.mockRejectedValue(
      new CalderynError({ code: "refund_exceeds_default", status: 422, message: "too much" }),
    );
    const { action } = await import("../dashboard.api.orders.$id.returns");
    const res = (await action({
      request: req(URL_, "POST", { lines: [{ order_line_id: "line-1", quantity: 1, restock: true, refund_cents: 99999 }] }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("refund_exceeds_default");
  });

  it("surfaces return_already_open as 409", async () => {
    const { CalderynError } = await import("~/lib/calderyn.server");
    returns.createOrderReturn.mockRejectedValue(
      new CalderynError({ code: "return_already_open", status: 409, message: "already open" }),
    );
    const { action } = await import("../dashboard.api.orders.$id.returns");
    const res = (await action({
      request: req(URL_, "POST", { lines: [{ order_line_id: "line-1", quantity: 1, restock: true }] }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("return_already_open");
  });

  it("rejects a cross-origin request without calling createOrderReturn", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns");
    const res = await action({
      request: req(URL_, "POST", { lines: [{ order_line_id: "line-1", quantity: 1, restock: true }] }, "https://evil.example"),
      params: { id: ORDER_ID },
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(returns.createOrderReturn).not.toHaveBeenCalled();
  });
});
