// Route test for POST /dashboard/api/orders/:id/recovery-email (orders phase 3, Task 4).
// sendRecoveryEmail's own eligibility rules (consent, at-most-once, channel/state guards) are
// unit-tested in recovery.server.test.ts, so it's mocked here; only the route boundary (session,
// CSRF, imported-order guard, native-existence 404) is exercised. Mirrors
// dashboard.api.orders.detail.test.ts's convention: session.server + http.server mocked/real,
// detail.server's isImportedOrderId/stripNativeOrderPrefix/nativeOrderExists kept REAL
// (importOriginal) so nativeOrderExists exercises the genuine implementation against the fake
// Supabase client below.
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
vi.mock("~/lib/order/detail.server", async (importOriginal) => ({
  ...(await importOriginal<typeof DetailServer>()),
}));

const recovery = vi.hoisted(() => ({ sendRecoveryEmail: vi.fn() }));
vi.mock("~/lib/order/recovery.server", () => recovery);

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
  recovery.sendRecoveryEmail.mockResolvedValue({ sent: true });
});

describe("POST /dashboard/api/orders/:id/recovery-email", () => {
  const url = `${ORIGIN}/dashboard/api/orders/order-1/recovery-email`;

  it("happy path: calls sendRecoveryEmail(manual: true) and returns {sent, reason}", async () => {
    seedOrder("order-1");
    const { action } = await import("../dashboard.api.orders.$id.recovery-email");
    const res = (await action({ request: post(url), params: { id: "order-1" } } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    expect(recovery.sendRecoveryEmail).toHaveBeenCalledWith("shop-1", "order-1", { manual: true });
  });

  it("passes through a structured not-sent reason (e.g. no_consent) rather than erroring", async () => {
    seedOrder("order-1");
    recovery.sendRecoveryEmail.mockResolvedValue({ sent: false, reason: "no_consent" });
    const { action } = await import("../dashboard.api.orders.$id.recovery-email");
    const res = (await action({ request: post(url), params: { id: "order-1" } } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: false, reason: "no_consent" });
  });

  it("404s an unknown order id without calling sendRecoveryEmail", async () => {
    const { action } = await import("../dashboard.api.orders.$id.recovery-email");
    const res = await action({ request: post(url), params: { id: "order-1" } } as never).catch((e) => e as Response);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("order_not_found");
    expect(recovery.sendRecoveryEmail).not.toHaveBeenCalled();
  });

  it("422s an imported (shopify:) order id without calling sendRecoveryEmail", async () => {
    const { action } = await import("../dashboard.api.orders.$id.recovery-email");
    const res = (await action({
      request: post(`${ORIGIN}/dashboard/api/orders/shopify:1/recovery-email`),
      params: { id: "shopify:1" },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("imported_read_only");
    expect(recovery.sendRecoveryEmail).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request without calling sendRecoveryEmail", async () => {
    seedOrder("order-1");
    const { action } = await import("../dashboard.api.orders.$id.recovery-email");
    const res = await action({
      request: post(url, "https://evil.example"),
      params: { id: "order-1" },
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(recovery.sendRecoveryEmail).not.toHaveBeenCalled();
  });

  it("accepts a calderyn:-prefixed id, stripping it before calling sendRecoveryEmail", async () => {
    seedOrder("order-1");
    const { action } = await import("../dashboard.api.orders.$id.recovery-email");
    const res = (await action({
      request: post(`${ORIGIN}/dashboard/api/orders/calderyn:order-1/recovery-email`),
      params: { id: "calderyn:order-1" },
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(recovery.sendRecoveryEmail).toHaveBeenCalledWith("shop-1", "order-1", { manual: true });
  });
});
