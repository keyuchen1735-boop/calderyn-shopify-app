// Route test for POST /dashboard/api/orders/:id/resend-invoice (orders phase 3, Task 5).
// resendInvoiceEmail's own eligibility rules (channel/state guards, confirmation_token)
// are unit-tested in invoice.server.test.ts, so it's mocked here; only the route boundary
// (session, CSRF, imported-order guard) is exercised. Mirrors dashboard.api.orders.recovery-email.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as HttpServer from "~/lib/dashboard/http.server";
import type * as DetailServer from "~/lib/order/detail.server";

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
// Keep detail.server's nativeOrderExists real (importOriginal) so it exercises genuine
// implementation against the fake Supabase client seeded below.
vi.mock("~/lib/order/detail.server", async (importOriginal) => ({
  ...(await importOriginal<typeof DetailServer>()),
}));

const invoice = vi.hoisted(() => ({ resendInvoiceEmail: vi.fn() }));
vi.mock("~/lib/order/invoice.server", () => invoice);

type Row = Record<string, any>;
const store = vi.hoisted(() => ({ db: { orders: [] as Row[] } }));

class Builder {
  private filters: Array<[string, unknown]> = [];
  private wantSingle = false;
  private readonly table: "orders";
  constructor(table: "orders") {
    this.table = table;
  }
  select(_cols?: string) {
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  maybeSingle() {
    this.wantSingle = true;
    const matched = store.db[this.table].filter((r) => this.filters.every(([c, v]) => r[c] === v));
    return Promise.resolve({ data: matched[0] ?? null, error: null });
  }
}

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: (t: "orders") => new Builder(t) }) }));

function seedOrder(id: string, extra: Row = {}) {
  store.db.orders.push({ id, shop_id: "shop-1", ...extra });
}

function post(url: string, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  return new Request(url, { method: "POST", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.db.orders.length = 0;
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
  invoice.resendInvoiceEmail.mockResolvedValue({ sent: true });
});

describe("POST /dashboard/api/orders/:id/resend-invoice", () => {
  const url = `${ORIGIN}/dashboard/api/orders/order-1/resend-invoice`;

  it("happy path: calls resendInvoiceEmail and returns {sent}", async () => {
    seedOrder("order-1");
    const { action } = await import("../dashboard.api.orders.$id.resend-invoice");
    const res = (await action({ request: post(url), params: { id: "order-1" } } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    expect(invoice.resendInvoiceEmail).toHaveBeenCalledWith("shop-1", "order-1");
  });

  it("passes through a structured not-sent reason (e.g. not_pending) rather than erroring", async () => {
    seedOrder("order-1");
    invoice.resendInvoiceEmail.mockResolvedValue({ sent: false, reason: "invoice_not_pending" });
    const { action } = await import("../dashboard.api.orders.$id.resend-invoice");
    const res = (await action({ request: post(url), params: { id: "order-1" } } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: false, reason: "invoice_not_pending" });
  });

  it("404s an unknown order id without calling resendInvoiceEmail", async () => {
    const { action } = await import("../dashboard.api.orders.$id.resend-invoice");
    const res = await action({ request: post(url), params: { id: "order-1" } } as never).catch((e) => e as Response);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("order_not_found");
    expect(invoice.resendInvoiceEmail).not.toHaveBeenCalled();
  });

  it("422s an imported (shopify:) order id without calling resendInvoiceEmail", async () => {
    const { action } = await import("../dashboard.api.orders.$id.resend-invoice");
    const res = (await action({
      request: post(`${ORIGIN}/dashboard/api/orders/shopify:1/resend-invoice`),
      params: { id: "shopify:1" },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("imported_read_only");
    expect(invoice.resendInvoiceEmail).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request without calling resendInvoiceEmail", async () => {
    seedOrder("order-1");
    const { action } = await import("../dashboard.api.orders.$id.resend-invoice");
    const res = await action({
      request: post(url, "https://evil.example"),
      params: { id: "order-1" },
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(invoice.resendInvoiceEmail).not.toHaveBeenCalled();
  });

  it("accepts a calderyn:-prefixed id, stripping it before calling resendInvoiceEmail", async () => {
    seedOrder("order-1");
    const { action } = await import("../dashboard.api.orders.$id.resend-invoice");
    const res = (await action({
      request: post(`${ORIGIN}/dashboard/api/orders/calderyn:order-1/resend-invoice`),
      params: { id: "calderyn:order-1" },
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(invoice.resendInvoiceEmail).toHaveBeenCalledWith("shop-1", "order-1");
  });
});
