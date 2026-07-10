// Route tests for POST /dashboard/api/orders/:id/reduce-line (orders phase 3, Task 3).
// Boundary validation + the native-only guard are asserted here; executeReduceLineAction's own
// domain behavior (preconditions, refund delta, restock) is unit-tested in edit.server.test.ts,
// so it's mocked.
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

const edit = vi.hoisted(() => ({ executeReduceLineAction: vi.fn() }));
vi.mock("~/lib/order/edit.server", () => edit);
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({}) }));

function req(url: string, method: string, body?: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

const ORDER_ID = "order-1";
const URL_ = `${ORIGIN}/dashboard/api/orders/${ORDER_ID}/reduce-line`;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
  edit.executeReduceLineAction.mockResolvedValue({
    auditId: "audit-1",
    orderState: "partially_refunded",
    refundedCents: 2000,
    restocked: true,
    restockError: null,
    replayed: false,
  });
});

describe("POST /dashboard/api/orders/:id/reduce-line", () => {
  it("reduces a valid line", async () => {
    const { action } = await import("../dashboard.api.orders.$id.reduce-line");
    const res = (await action({
      request: req(URL_, "POST", { order_line_id: "line-1", new_quantity: 2, restock: true, idempotency_key: "k1" }),
      params: { id: ORDER_ID },
    } as never)) as Response;

    expect(res.status).toBe(200);
    expect(edit.executeReduceLineAction).toHaveBeenCalledWith(
      "shop-1",
      {
        orderId: ORDER_ID,
        orderLineId: "line-1",
        newQuantity: 2,
        restock: true,
        reason: null,
        idempotencyKey: "k1",
        actor: "merchant:web-dashboard",
      },
      expect.anything(),
    );
    expect(await res.json()).toEqual({
      audit_id: "audit-1",
      order_state: "partially_refunded",
      refunded_cents: 2000,
      restocked: true,
      restock_error: null,
    });
  });

  it("refuses an imported (shopify:) order id", async () => {
    const { action } = await import("../dashboard.api.orders.$id.reduce-line");
    const res = (await action({
      request: req(`${ORIGIN}/dashboard/api/orders/shopify:99/reduce-line`, "POST", {
        order_line_id: "line-1",
        new_quantity: 1,
        restock: false,
        idempotency_key: "k2",
      }),
      params: { id: "shopify:99" },
    } as never)) as Response;

    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("imported_read_only");
    expect(edit.executeReduceLineAction).not.toHaveBeenCalled();
  });

  it("422s a missing order_line_id", async () => {
    const { action } = await import("../dashboard.api.orders.$id.reduce-line");
    const res = (await action({
      request: req(URL_, "POST", { new_quantity: 1, restock: false, idempotency_key: "k3" }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_order_line_id");
  });

  it("422s a negative new_quantity", async () => {
    const { action } = await import("../dashboard.api.orders.$id.reduce-line");
    const res = (await action({
      request: req(URL_, "POST", { order_line_id: "line-1", new_quantity: -1, restock: false, idempotency_key: "k4" }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_quantity");
  });

  it("422s a non-integer new_quantity", async () => {
    const { action } = await import("../dashboard.api.orders.$id.reduce-line");
    const res = (await action({
      request: req(URL_, "POST", { order_line_id: "line-1", new_quantity: 1.5, restock: false, idempotency_key: "k4b" }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_quantity");
  });

  it("422s a non-boolean restock", async () => {
    const { action } = await import("../dashboard.api.orders.$id.reduce-line");
    const res = (await action({
      request: req(URL_, "POST", { order_line_id: "line-1", new_quantity: 1, restock: "yes", idempotency_key: "k5" }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_restock");
  });

  it("422s a reason longer than 500 characters", async () => {
    const { action } = await import("../dashboard.api.orders.$id.reduce-line");
    const res = (await action({
      request: req(URL_, "POST", {
        order_line_id: "line-1",
        new_quantity: 1,
        restock: false,
        idempotency_key: "k4c",
        reason: "x".repeat(501),
      }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_reason");
    expect(edit.executeReduceLineAction).not.toHaveBeenCalled();
  });

  it("accepts a reason at exactly 500 characters", async () => {
    const { action } = await import("../dashboard.api.orders.$id.reduce-line");
    const res = (await action({
      request: req(URL_, "POST", {
        order_line_id: "line-1",
        new_quantity: 1,
        restock: false,
        idempotency_key: "k4d",
        reason: "x".repeat(500),
      }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(200);
  });

  it("422s a missing idempotency_key", async () => {
    const { action } = await import("../dashboard.api.orders.$id.reduce-line");
    const res = (await action({
      request: req(URL_, "POST", { order_line_id: "line-1", new_quantity: 1, restock: false }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("missing_idempotency_key");
  });

  it("surfaces a CalderynError's status/code from the executor", async () => {
    const { CalderynError } = await import("~/lib/calderyn.server");
    edit.executeReduceLineAction.mockRejectedValue(
      new CalderynError({ code: "below_fulfilled", status: 409, message: "already shipped" }),
    );
    const { action } = await import("../dashboard.api.orders.$id.reduce-line");
    const res = (await action({
      request: req(URL_, "POST", { order_line_id: "line-1", new_quantity: 1, restock: false, idempotency_key: "k6" }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("below_fulfilled");
  });

  it("rejects a cross-origin request without calling the executor", async () => {
    const { action } = await import("../dashboard.api.orders.$id.reduce-line");
    const res = await action({
      request: req(URL_, "POST", { order_line_id: "line-1", new_quantity: 1, restock: false, idempotency_key: "k7" }, "https://evil.example"),
      params: { id: ORDER_ID },
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(edit.executeReduceLineAction).not.toHaveBeenCalled();
  });
});
