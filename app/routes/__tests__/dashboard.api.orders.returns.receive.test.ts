// Route tests for POST /dashboard/api/orders/:id/returns/receive (orders Phase 4, Task 2).
// Boundary validation is asserted here; executeReturnReceivedAction's own domain behavior
// (resume, over-refund pre-check, restock/refund/CAS flip) is unit-tested in returns.server.test.ts,
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

const returns = vi.hoisted(() => ({ executeReturnReceivedAction: vi.fn() }));
vi.mock("~/lib/order/returns.server", () => returns);

function req(url: string, method: string, body?: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

const ORDER_ID = "order-1";
const URL_ = `${ORIGIN}/dashboard/api/orders/${ORDER_ID}/returns/receive`;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
  returns.executeReturnReceivedAction.mockResolvedValue({
    auditId: "audit-1",
    returnId: "ret-1",
    orderId: ORDER_ID,
    status: "closed",
    refundedCents: 1999,
    restockedLines: 1,
    restockErrors: null,
    replayed: false,
  });
});

describe("POST /dashboard/api/orders/:id/returns/receive", () => {
  it("marks a return received for a valid body", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns.receive");
    const res = (await action({
      request: req(URL_, "POST", { return_id: "ret-1", idempotency_key: "k1" }),
      params: { id: ORDER_ID },
    } as never)) as Response;

    expect(res.status).toBe(200);
    expect(returns.executeReturnReceivedAction).toHaveBeenCalledWith("shop-1", {
      returnId: "ret-1",
      idempotencyKey: "k1",
      actor: "merchant:web-dashboard",
    });
    expect(await res.json()).toEqual({
      audit_id: "audit-1",
      return_id: "ret-1",
      order_id: ORDER_ID,
      status: "closed",
      refunded_cents: 1999,
      restocked_lines: 1,
      restock_errors: null,
      replayed: false,
    });
  });

  it("refuses an imported (shopify:) order id", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns.receive");
    const res = (await action({
      request: req(`${ORIGIN}/dashboard/api/orders/shopify:99/returns/receive`, "POST", {
        return_id: "ret-1",
        idempotency_key: "k2",
      }),
      params: { id: "shopify:99" },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("imported_read_only");
    expect(returns.executeReturnReceivedAction).not.toHaveBeenCalled();
  });

  it("422s a missing return_id", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns.receive");
    const res = (await action({
      request: req(URL_, "POST", { idempotency_key: "k3" }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_return_id");
    expect(returns.executeReturnReceivedAction).not.toHaveBeenCalled();
  });

  it("422s a missing idempotency_key", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns.receive");
    const res = (await action({
      request: req(URL_, "POST", { return_id: "ret-1" }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("missing_idempotency_key");
    expect(returns.executeReturnReceivedAction).not.toHaveBeenCalled();
  });

  it("surfaces a CalderynError's status/code from the executor (over-refund 409)", async () => {
    const { CalderynError } = await import("~/lib/calderyn.server");
    returns.executeReturnReceivedAction.mockRejectedValue(
      new CalderynError({ code: "over_refund", status: 409, message: "would over-refund" }),
    );
    const { action } = await import("../dashboard.api.orders.$id.returns.receive");
    const res = (await action({
      request: req(URL_, "POST", { return_id: "ret-1", idempotency_key: "k4" }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("over_refund");
  });

  it("rejects a cross-origin request without calling the executor", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns.receive");
    const res = await action({
      request: req(URL_, "POST", { return_id: "ret-1", idempotency_key: "k5" }, "https://evil.example"),
      params: { id: ORDER_ID },
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(returns.executeReturnReceivedAction).not.toHaveBeenCalled();
  });
});
