// Route tests for POST /dashboard/api/orders/:id/returns/cancel (orders Phase 4, Task 2).
// Boundary validation is asserted here; cancelOrderReturn's own domain behavior (the CAS status
// flip) is unit-tested in returns.server.test.ts, so it's mocked.
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

const returns = vi.hoisted(() => ({ cancelOrderReturn: vi.fn(), returnBelongsToOrder: vi.fn() }));
vi.mock("~/lib/order/returns.server", () => returns);

function req(url: string, method: string, body?: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

const ORDER_ID = "order-1";
const URL_ = `${ORIGIN}/dashboard/api/orders/${ORDER_ID}/returns/cancel`;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
  returns.cancelOrderReturn.mockResolvedValue({ returnId: "ret-1", status: "cancelled" });
  returns.returnBelongsToOrder.mockResolvedValue(true);
});

describe("POST /dashboard/api/orders/:id/returns/cancel", () => {
  it("cancels an open return", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns.cancel");
    const res = (await action({
      request: req(URL_, "POST", { return_id: "ret-1" }),
      params: { id: ORDER_ID },
    } as never)) as Response;

    expect(res.status).toBe(200);
    expect(returns.returnBelongsToOrder).toHaveBeenCalledWith("shop-1", "ret-1", ORDER_ID);
    expect(returns.cancelOrderReturn).toHaveBeenCalledWith("shop-1", "ret-1");
    expect(await res.json()).toEqual({ return_id: "ret-1", status: "cancelled" });
  });

  it("404s return_not_found when the return_id does not belong to this order's URL", async () => {
    returns.returnBelongsToOrder.mockResolvedValue(false);
    const { action } = await import("../dashboard.api.orders.$id.returns.cancel");
    const res = (await action({
      request: req(URL_, "POST", { return_id: "ret-1" }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("return_not_found");
    expect(returns.cancelOrderReturn).not.toHaveBeenCalled();
  });

  it("refuses an imported (shopify:) order id", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns.cancel");
    const res = (await action({
      request: req(`${ORIGIN}/dashboard/api/orders/shopify:99/returns/cancel`, "POST", { return_id: "ret-1" }),
      params: { id: "shopify:99" },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("imported_read_only");
    expect(returns.cancelOrderReturn).not.toHaveBeenCalled();
  });

  it("422s a missing return_id", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns.cancel");
    const res = (await action({
      request: req(URL_, "POST", {}),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_return_id");
    expect(returns.cancelOrderReturn).not.toHaveBeenCalled();
  });

  it("surfaces a CalderynError's status/code from the executor (already closed 409)", async () => {
    const { CalderynError } = await import("~/lib/calderyn.server");
    returns.cancelOrderReturn.mockRejectedValue(
      new CalderynError({ code: "return_not_cancellable", status: 409, message: "not open" }),
    );
    const { action } = await import("../dashboard.api.orders.$id.returns.cancel");
    const res = (await action({
      request: req(URL_, "POST", { return_id: "ret-1" }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("return_not_cancellable");
  });

  it("rejects a cross-origin request without calling cancelOrderReturn", async () => {
    const { action } = await import("../dashboard.api.orders.$id.returns.cancel");
    const res = await action({
      request: req(URL_, "POST", { return_id: "ret-1" }, "https://evil.example"),
      params: { id: ORDER_ID },
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(returns.cancelOrderReturn).not.toHaveBeenCalled();
  });
});
