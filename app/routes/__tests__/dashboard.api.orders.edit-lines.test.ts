// Route tests for POST /dashboard/api/orders/:id/edit-lines (orders phase 3, Task 3).
// Boundary validation + the native-only guard are asserted here; executeEditInvoiceLines' own
// domain behavior (pricing, re-quoting, guard on channel/state) is unit-tested in
// edit.server.test.ts, so it's mocked.
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

const edit = vi.hoisted(() => ({ executeEditInvoiceLines: vi.fn() }));
vi.mock("~/lib/order/edit.server", () => edit);
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({}) }));

function req(url: string, method: string, body?: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

const ORDER_ID = "order-1";
const URL_ = `${ORIGIN}/dashboard/api/orders/${ORDER_ID}/edit-lines`;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
  edit.executeEditInvoiceLines.mockResolvedValue({
    orderId: ORDER_ID,
    subtotalCents: 3000,
    shippingCents: 0,
    taxCents: 0,
    totalCents: 3000,
    currency: "usd",
  });
});

describe("POST /dashboard/api/orders/:id/edit-lines", () => {
  it("replaces lines for a valid body", async () => {
    const { action } = await import("../dashboard.api.orders.$id.edit-lines");
    const res = (await action({
      request: req(URL_, "POST", { lines: [{ variant_id: "v-1", quantity: 2 }] }),
      params: { id: ORDER_ID },
    } as never)) as Response;

    expect(res.status).toBe(200);
    expect(edit.executeEditInvoiceLines).toHaveBeenCalledWith(
      "shop-1",
      ORDER_ID,
      [{ variantId: "v-1", quantity: 2 }],
      expect.anything(),
    );
    expect(await res.json()).toEqual({
      order_id: ORDER_ID,
      subtotal_cents: 3000,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: 3000,
      currency: "usd",
    });
  });

  it("refuses an imported (shopify:) order id", async () => {
    const { action } = await import("../dashboard.api.orders.$id.edit-lines");
    const res = (await action({
      request: req(`${ORIGIN}/dashboard/api/orders/shopify:99/edit-lines`, "POST", {
        lines: [{ variant_id: "v-1", quantity: 1 }],
      }),
      params: { id: "shopify:99" },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("imported_read_only");
    expect(edit.executeEditInvoiceLines).not.toHaveBeenCalled();
  });

  it("422s an empty lines array", async () => {
    const { action } = await import("../dashboard.api.orders.$id.edit-lines");
    const res = (await action({
      request: req(URL_, "POST", { lines: [] }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_lines");
  });

  it("422s more than 50 lines", async () => {
    const { action } = await import("../dashboard.api.orders.$id.edit-lines");
    const lines = Array.from({ length: 51 }, (_, i) => ({ variant_id: `v-${i}`, quantity: 1 }));
    const res = (await action({
      request: req(URL_, "POST", { lines }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_lines");
  });

  it("422s a line with a bad quantity", async () => {
    const { action } = await import("../dashboard.api.orders.$id.edit-lines");
    const res = (await action({
      request: req(URL_, "POST", { lines: [{ variant_id: "v-1", quantity: 0 }] }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_lines");
  });

  it("422s a line missing variant_id", async () => {
    const { action } = await import("../dashboard.api.orders.$id.edit-lines");
    const res = (await action({
      request: req(URL_, "POST", { lines: [{ quantity: 1 }] }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_lines");
  });

  it("surfaces a CalderynError's status/code from the executor (e.g. not an editable invoice)", async () => {
    const { CalderynError } = await import("~/lib/calderyn.server");
    edit.executeEditInvoiceLines.mockRejectedValue(
      new CalderynError({ code: "not_editable_invoice", status: 409, message: "not editable" }),
    );
    const { action } = await import("../dashboard.api.orders.$id.edit-lines");
    const res = (await action({
      request: req(URL_, "POST", { lines: [{ variant_id: "v-1", quantity: 1 }] }),
      params: { id: ORDER_ID },
    } as never)) as Response;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_editable_invoice");
  });

  it("rejects a cross-origin request without calling the executor", async () => {
    const { action } = await import("../dashboard.api.orders.$id.edit-lines");
    const res = await action({
      request: req(URL_, "POST", { lines: [{ variant_id: "v-1", quantity: 1 }] }, "https://evil.example"),
      params: { id: ORDER_ID },
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(edit.executeEditInvoiceLines).not.toHaveBeenCalled();
  });
});
