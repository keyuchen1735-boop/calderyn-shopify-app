// Route tests for POST /dashboard/api/orders/drafts/send (orders phase 3, Task 2). Validation
// at the boundary is asserted here; sendDraftOrderInvoice's own domain behavior (pricing,
// payments-not-ready gate, etc.) is unit-tested in invoice.server.test.ts, so it's mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as HttpServer from "~/lib/dashboard/http.server";
import { CalderynError } from "~/lib/calderyn.server";

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

const invoice = vi.hoisted(() => ({ sendDraftOrderInvoice: vi.fn() }));
vi.mock("~/lib/order/invoice.server", () => invoice);

function req(url: string, method: string, body?: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

const URL_ = `${ORIGIN}/dashboard/api/orders/drafts/send`;
const CART_ID = "3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
  invoice.sendDraftOrderInvoice.mockResolvedValue({
    orderId: "order-1",
    confirmationToken: "tok-abc",
    totalCents: 3998,
    currency: "usd",
    emailSent: true,
  });
});

describe("POST /dashboard/api/orders/drafts/send", () => {
  it("sends the invoice for a valid body", async () => {
    const { action } = await import("../dashboard.api.orders.drafts.send");
    const res = (await action({
      request: req(URL_, "POST", { cart_id: CART_ID, email: "Buyer@Example.com" }),
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(invoice.sendDraftOrderInvoice).toHaveBeenCalledWith("shop-1", CART_ID, {
      email: "buyer@example.com",
      address: undefined,
      note: null,
    });
    expect(await res.json()).toEqual({
      order_id: "order-1",
      confirmation_token: "tok-abc",
      total_cents: 3998,
      currency: "usd",
      email_sent: true,
    });
  });

  it("passes through a valid address and note", async () => {
    const { action } = await import("../dashboard.api.orders.drafts.send");
    await action({
      request: req(URL_, "POST", {
        cart_id: CART_ID,
        email: "b@example.com",
        address: { line1: "123 Main St", city: "Springfield", region: "IL", postal: "62701", country: "US" },
        note: "Please pay within 7 days",
      }),
    } as never);
    expect(invoice.sendDraftOrderInvoice).toHaveBeenCalledWith("shop-1", CART_ID, {
      email: "b@example.com",
      address: {
        kind: "shipping",
        name: null,
        line1: "123 Main St",
        line2: null,
        city: "Springfield",
        region: "IL",
        postal: "62701",
        country: "US",
        phone: null,
      },
      note: "Please pay within 7 days",
    });
  });

  it("422s a non-uuid cart_id", async () => {
    const { action } = await import("../dashboard.api.orders.drafts.send");
    const res = (await action({
      request: req(URL_, "POST", { cart_id: "not-a-uuid", email: "b@example.com" }),
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_cart_id");
    expect(invoice.sendDraftOrderInvoice).not.toHaveBeenCalled();
  });

  it("422s an invalid email", async () => {
    const { action } = await import("../dashboard.api.orders.drafts.send");
    const res = (await action({
      request: req(URL_, "POST", { cart_id: CART_ID, email: "not-an-email" }),
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_email");
    expect(invoice.sendDraftOrderInvoice).not.toHaveBeenCalled();
  });

  it("422s an address missing line1", async () => {
    const { action } = await import("../dashboard.api.orders.drafts.send");
    const res = (await action({
      request: req(URL_, "POST", { cart_id: CART_ID, email: "b@example.com", address: { city: "Springfield" } }),
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_address");
  });

  it("422s a note over 500 characters", async () => {
    const { action } = await import("../dashboard.api.orders.drafts.send");
    const res = (await action({
      request: req(URL_, "POST", { cart_id: CART_ID, email: "b@example.com", note: "x".repeat(501) }),
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_note");
  });

  it("409s (payments_not_ready) when sendDraftOrderInvoice fails closed", async () => {
    invoice.sendDraftOrderInvoice.mockRejectedValue(
      new CalderynError({ code: "payments_not_ready", status: 409, message: "not ready" }),
    );
    const { action } = await import("../dashboard.api.orders.drafts.send");
    const res = await action({
      request: req(URL_, "POST", { cart_id: CART_ID, email: "b@example.com" }),
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("payments_not_ready");
  });

  it("rejects a cross-origin request without sending", async () => {
    const { action } = await import("../dashboard.api.orders.drafts.send");
    const res = await action({
      request: req(URL_, "POST", { cart_id: CART_ID, email: "b@example.com" }, "https://evil.example"),
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(invoice.sendDraftOrderInvoice).not.toHaveBeenCalled();
  });
});
