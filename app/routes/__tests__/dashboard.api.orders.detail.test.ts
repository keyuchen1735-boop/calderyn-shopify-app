// Route tests for the six order-management API routes (Task 10): detail (GET), fulfill,
// cancel, notes, tags, archive (all POST). Convention mirrors dashboard.api.catalog.products.test.ts
// (session.server + http.server + executors mocked) crossed with dashboard.api.account.test.ts's
// approach to requireSameOrigin (kept REAL via importOriginal + DASHBOARD_PUBLIC_URL, so the
// cross-origin 403 is asserted against actual CSRF-guard behavior, not a no-op spy).
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

const loadOrderDetail = vi.fn();
// Keep isImportedOrderId / stripNativeOrderPrefix / nativeOrderExists REAL (importOriginal): they're
// pure/thin-wrapper helpers, and nativeOrderExists operates on whatever SupabaseClient the route
// passes it — here that's the fake `store.client` below — so the existence-check tests exercise the
// genuine implementation, not a stand-in.
vi.mock("~/lib/order/detail.server", async (importOriginal) => ({
  ...(await importOriginal<typeof DetailServer>()),
  loadOrderDetail: (...a: unknown[]) => loadOrderDetail(...a),
}));

const executeFulfillAction = vi.fn();
// parseFulfillLinesBody stays REAL (importOriginal): it IS the route's boundary validation.
vi.mock("~/lib/order/fulfill.server", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  executeFulfillAction: (...a: unknown[]) => executeFulfillAction(...a),
}));

const executeCancelAction = vi.fn();
vi.mock("~/lib/order/cancel.server", () => ({
  executeCancelAction: (...a: unknown[]) => executeCancelAction(...a),
}));

// Minimal in-memory Supabase stand-in for the notes/tags/archive routes' direct table
// access (existence check + insert/delete/update). Same Builder shape as
// fulfill.server.test.ts / cancel.server.test.ts, extended with delete().
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { orders: [], order_note: [], order_tag: [], users: [] };

  class Builder {
    private op: "select" | "insert" | "update" | "delete" = "select";
    private payload: Row | Row[] = {};
    private vals: Row = {};
    private filters: Array<[string, unknown]> = [];
    private wantSingle = false;
    private readonly table: string;
    constructor(table: string) {
      this.table = table;
    }
    insert(payload: Row | Row[]) {
      this.op = "insert";
      this.payload = payload;
      return this;
    }
    update(vals: Row) {
      this.op = "update";
      this.vals = vals;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
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
      return this;
    }
    single() {
      this.wantSingle = true;
      return this;
    }
    then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
    private wrap(rows: Row[]) {
      return { data: this.wantSingle ? (rows[0] ?? null) : rows, error: null };
    }
    private insertOne(p: Row): Row {
      const t = db[this.table];
      const row: Row = { id: `${this.table}-${t.length + 1}`, created_at: new Date().toISOString(), ...p };
      t.push(row);
      return row;
    }
    private matches(r: Row): boolean {
      return this.filters.every(([c, v]) => r[c] === v);
    }
    private run(): { data: unknown; error: unknown } {
      const t = db[this.table];
      if (this.op === "insert") {
        const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((p) => this.insertOne(p));
        return this.wrap(rows);
      }
      if (this.op === "update") {
        const matched = t.filter((r) => this.matches(r));
        for (const r of matched) Object.assign(r, this.vals);
        return this.wrap(matched);
      }
      if (this.op === "delete") {
        const kept = t.filter((r) => !this.matches(r));
        t.length = 0;
        t.push(...kept);
        return this.wrap([]);
      }
      return this.wrap(t.filter((r) => this.matches(r)));
    }
  }

  const client = { from: (table: string) => new Builder(table) };
  return { db, client };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));

function seedOrder(id: string, extra: Record<string, unknown> = {}) {
  store.db.orders.push({ id, shop_id: "shop-1", archived_at: null, ...extra });
}

function post(url: string, body: unknown, origin: string | null = ORIGIN, method = "POST"): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  return new Request(url, { method, headers, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
  loadOrderDetail.mockReset();
  executeFulfillAction.mockReset();
  executeCancelAction.mockReset();
});

describe("GET /dashboard/api/orders/:id", () => {
  it("404s an unknown order id", async () => {
    loadOrderDetail.mockResolvedValue(null);
    const { loader } = await import("../dashboard.api.orders.$id");
    await expect(
      loader({ request: new Request(`${ORIGIN}/dashboard/api/orders/nope`), params: { id: "nope" } } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(loadOrderDetail).toHaveBeenCalledWith("shop-1", "nope");
  });

  it("returns the order detail on a known id", async () => {
    loadOrderDetail.mockResolvedValue({ id: "order-1", state: "paid" });
    const { loader } = await import("../dashboard.api.orders.$id");
    const res = (await loader({
      request: new Request(`${ORIGIN}/dashboard/api/orders/order-1`),
      params: { id: "order-1" },
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ order: { id: "order-1", state: "paid" } });
  });
});

describe("POST /dashboard/api/orders/:id/fulfill", () => {
  const url = `${ORIGIN}/dashboard/api/orders/order-1/fulfill`;
  const body = { notify: true, idempotency_key: "k1" };

  it("happy path: calls the executor and returns order_state", async () => {
    executeFulfillAction.mockResolvedValue({
      auditId: "audit-1",
      fulfillmentId: "f1",
      orderState: "fulfilled",
      fulfilledUnits: 2,
      notified: true,
      replayed: false,
    });
    const { action } = await import("../dashboard.api.orders.$id.fulfill");
    const res = (await action({ request: post(url, body), params: { id: "order-1" } } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      audit_id: "audit-1",
      fulfillment_id: "f1",
      order_state: "fulfilled",
      fulfilled_units: 2,
      notified: true,
    });
    expect(executeFulfillAction).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ orderId: "order-1", notify: true, idempotencyKey: "k1" }),
    );
  });

  it("rejects a cross-origin request without calling the executor", async () => {
    const { action } = await import("../dashboard.api.orders.$id.fulfill");
    const res = await action({ request: post(url, body, "https://evil.example"), params: { id: "order-1" } } as never).catch(
      (e) => e as Response,
    );
    expect(res.status).toBe(403);
    expect(executeFulfillAction).not.toHaveBeenCalled();
  });

  it("422s an imported (shopify:) order id without calling the executor", async () => {
    const { action } = await import("../dashboard.api.orders.$id.fulfill");
    const res = (await action({
      request: post(`${ORIGIN}/dashboard/api/orders/shopify:1/fulfill`, body),
      params: { id: "shopify:1" },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("imported_read_only");
    expect(executeFulfillAction).not.toHaveBeenCalled();
  });

  it("422s a missing idempotency_key without calling the executor", async () => {
    const { action } = await import("../dashboard.api.orders.$id.fulfill");
    const res = (await action({
      request: post(url, { notify: true }),
      params: { id: "order-1" },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect(executeFulfillAction).not.toHaveBeenCalled();
  });

  it("a literal JSON `null` body is treated as empty (422, not a crash)", async () => {
    const { action } = await import("../dashboard.api.orders.$id.fulfill");
    const res = (await action({ request: post(url, null), params: { id: "order-1" } } as never)) as Response;
    expect(res.status).toBe(422);
    expect(executeFulfillAction).not.toHaveBeenCalled();
  });

  it("accepts a calderyn:-prefixed id, stripping it before calling the executor", async () => {
    executeFulfillAction.mockResolvedValue({
      auditId: "audit-1",
      fulfillmentId: "f1",
      orderState: "fulfilled",
      fulfilledUnits: 1,
      notified: false,
      replayed: false,
    });
    const { action } = await import("../dashboard.api.orders.$id.fulfill");
    const res = (await action({
      request: post(`${ORIGIN}/dashboard/api/orders/calderyn:order-1/fulfill`, body),
      params: { id: "calderyn:order-1" },
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(executeFulfillAction).toHaveBeenCalledWith("shop-1", expect.objectContaining({ orderId: "order-1" }));
  });
});

describe("POST /dashboard/api/orders/:id/cancel", () => {
  const url = `${ORIGIN}/dashboard/api/orders/order-2/cancel`;
  const body = { refund: true, restock: true, idempotency_key: "k2" };

  it("happy path with refund: returns refunded true", async () => {
    executeCancelAction.mockResolvedValue({
      auditId: "audit-2",
      orderState: "refunded",
      refunded: true,
      restockedLines: 3,
      replayed: false,
    });
    const { action } = await import("../dashboard.api.orders.$id.cancel");
    const res = (await action({ request: post(url, body), params: { id: "order-2" } } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      audit_id: "audit-2",
      order_state: "refunded",
      refunded: true,
      restocked_lines: 3,
    });
    expect(executeCancelAction).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ orderId: "order-2", refund: true, restock: true, idempotencyKey: "k2" }),
    );
  });

  it("rejects a cross-origin request without calling the executor", async () => {
    const { action } = await import("../dashboard.api.orders.$id.cancel");
    const res = await action({ request: post(url, body, "https://evil.example"), params: { id: "order-2" } } as never).catch(
      (e) => e as Response,
    );
    expect(res.status).toBe(403);
    expect(executeCancelAction).not.toHaveBeenCalled();
  });

  it("422s an imported (shopify:) order id without calling the executor", async () => {
    const { action } = await import("../dashboard.api.orders.$id.cancel");
    const res = (await action({
      request: post(`${ORIGIN}/dashboard/api/orders/shopify:2/cancel`, body),
      params: { id: "shopify:2" },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("imported_read_only");
    expect(executeCancelAction).not.toHaveBeenCalled();
  });

  it("a literal JSON `null` body is treated as empty (422, not a crash)", async () => {
    const { action } = await import("../dashboard.api.orders.$id.cancel");
    const res = (await action({ request: post(url, null), params: { id: "order-2" } } as never)) as Response;
    expect(res.status).toBe(422);
    expect(executeCancelAction).not.toHaveBeenCalled();
  });
});

describe("POST /dashboard/api/orders/:id/notes", () => {
  const url = `${ORIGIN}/dashboard/api/orders/order-3/notes`;

  it("inserts a note authored by the fallback merchant identity", async () => {
    seedOrder("order-3");
    const { action } = await import("../dashboard.api.orders.$id.notes");
    const res = (await action({
      request: post(url, { body: "Called the buyer, confirmed address." }),
      params: { id: "order-3" },
    } as never)) as Response;
    expect(res.status).toBe(200);
    const json = (await res.json()) as { note_id: string };
    expect(typeof json.note_id).toBe("string");
    expect(store.db.order_note).toHaveLength(1);
    expect(store.db.order_note[0]).toMatchObject({
      shop_id: "shop-1",
      order_id: "order-3",
      body: "Called the buyer, confirmed address.",
      author_email: "merchant",
    });
  });

  it("404s a note on an unknown order", async () => {
    const { action } = await import("../dashboard.api.orders.$id.notes");
    await expect(
      action({ request: post(url, { body: "hi" }), params: { id: "order-3" } } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.db.order_note).toHaveLength(0);
  });

  it("422s a body outside the 1-2000 char bound", async () => {
    seedOrder("order-3");
    const { action } = await import("../dashboard.api.orders.$id.notes");
    const res = (await action({ request: post(url, { body: "" }), params: { id: "order-3" } } as never)) as Response;
    expect(res.status).toBe(422);
    expect(store.db.order_note).toHaveLength(0);
  });

  it("rejects a cross-origin request without inserting", async () => {
    seedOrder("order-3");
    const { action } = await import("../dashboard.api.orders.$id.notes");
    const res = await action({
      request: post(url, { body: "hi" }, "https://evil.example"),
      params: { id: "order-3" },
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(store.db.order_note).toHaveLength(0);
  });

  it("422s an imported (shopify:) order id without inserting", async () => {
    const { action } = await import("../dashboard.api.orders.$id.notes");
    const res = (await action({
      request: post(`${ORIGIN}/dashboard/api/orders/shopify:3/notes`, { body: "hi" }),
      params: { id: "shopify:3" },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("imported_read_only");
    expect(store.db.order_note).toHaveLength(0);
  });

  it("a literal JSON `null` body is treated as empty (422, not a crash)", async () => {
    seedOrder("order-3");
    const { action } = await import("../dashboard.api.orders.$id.notes");
    const res = (await action({ request: post(url, null), params: { id: "order-3" } } as never)) as Response;
    expect(res.status).toBe(422);
    expect(store.db.order_note).toHaveLength(0);
  });
});

describe("POST /dashboard/api/orders/:id/tags", () => {
  const url = `${ORIGIN}/dashboard/api/orders/order-4/tags`;

  it("full-replace round-trip: trims, lowercases, and dedupes", async () => {
    seedOrder("order-4");
    store.db.order_tag.push({ shop_id: "shop-1", order_id: "order-4", tag: "stale" });

    const { action } = await import("../dashboard.api.orders.$id.tags");
    const res = (await action({
      request: post(url, { tags: [" VIP ", "vip", "Wholesale"] }),
      params: { id: "order-4" },
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tags: ["vip", "wholesale"] });
    expect(store.db.order_tag.map((t) => t.tag).sort()).toEqual(["vip", "wholesale"]);
  });

  it("422s more than 20 tags without writing", async () => {
    seedOrder("order-4");
    const many = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    const { action } = await import("../dashboard.api.orders.$id.tags");
    const res = (await action({ request: post(url, { tags: many }), params: { id: "order-4" } } as never)) as Response;
    expect(res.status).toBe(422);
    expect(store.db.order_tag).toHaveLength(0);
  });

  it("404s tags on an unknown order", async () => {
    const { action } = await import("../dashboard.api.orders.$id.tags");
    await expect(
      action({ request: post(url, { tags: ["vip"] }), params: { id: "order-4" } } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a cross-origin request without writing", async () => {
    seedOrder("order-4");
    const { action } = await import("../dashboard.api.orders.$id.tags");
    const res = await action({
      request: post(url, { tags: ["vip"] }, "https://evil.example"),
      params: { id: "order-4" },
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(store.db.order_tag).toHaveLength(0);
  });

  it("422s an imported (shopify:) order id without writing", async () => {
    const { action } = await import("../dashboard.api.orders.$id.tags");
    const res = (await action({
      request: post(`${ORIGIN}/dashboard/api/orders/shopify:4/tags`, { tags: ["vip"] }),
      params: { id: "shopify:4" },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("imported_read_only");
  });

  it("a literal JSON `null` body is treated as empty (422, not a crash)", async () => {
    seedOrder("order-4");
    const { action } = await import("../dashboard.api.orders.$id.tags");
    const res = (await action({ request: post(url, null), params: { id: "order-4" } } as never)) as Response;
    expect(res.status).toBe(422);
    expect(store.db.order_tag).toHaveLength(0);
  });

  it("accepts a calderyn:-prefixed id, resolving to the same native order", async () => {
    seedOrder("order-4");
    const { action } = await import("../dashboard.api.orders.$id.tags");
    const res = (await action({
      request: post(`${ORIGIN}/dashboard/api/orders/calderyn:order-4/tags`, { tags: ["vip"] }),
      params: { id: "calderyn:order-4" },
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(store.db.order_tag.map((t) => t.order_id)).toEqual(["order-4"]);
  });
});

describe("POST /dashboard/api/orders/:id/archive", () => {
  const url = `${ORIGIN}/dashboard/api/orders/order-5/archive`;

  it("toggles archived on then off", async () => {
    seedOrder("order-5");
    const { action } = await import("../dashboard.api.orders.$id.archive");

    const onRes = (await action({
      request: post(url, { archived: true }),
      params: { id: "order-5" },
    } as never)) as Response;
    expect(onRes.status).toBe(200);
    expect(await onRes.json()).toEqual({ archived: true });
    expect(store.db.orders[0].archived_at).toBeTruthy();

    const offRes = (await action({
      request: post(url, { archived: false }),
      params: { id: "order-5" },
    } as never)) as Response;
    expect(offRes.status).toBe(200);
    expect(await offRes.json()).toEqual({ archived: false });
    expect(store.db.orders[0].archived_at).toBeNull();
  });

  it("404s archive on an unknown order", async () => {
    const { action } = await import("../dashboard.api.orders.$id.archive");
    // setOrderArchived (order.server.ts) throws a CalderynError like the fulfill/cancel
    // executors do, so dashboardJson resolves a 404 Response rather than rejecting.
    const res = (await action({
      request: post(url, { archived: true }),
      params: { id: "order-5" },
    } as never)) as Response;
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("order_not_found");
  });

  it("rejects a cross-origin request without writing", async () => {
    seedOrder("order-5");
    const { action } = await import("../dashboard.api.orders.$id.archive");
    const res = await action({
      request: post(url, { archived: true }, "https://evil.example"),
      params: { id: "order-5" },
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(store.db.orders[0].archived_at).toBeNull();
  });

  it("422s an imported (shopify:) order id without writing", async () => {
    const { action } = await import("../dashboard.api.orders.$id.archive");
    const res = (await action({
      request: post(`${ORIGIN}/dashboard/api/orders/shopify:5/archive`, { archived: true }),
      params: { id: "shopify:5" },
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("imported_read_only");
  });

  it("a literal JSON `null` body is treated as empty (422, not a crash)", async () => {
    seedOrder("order-5");
    const { action } = await import("../dashboard.api.orders.$id.archive");
    const res = (await action({ request: post(url, null), params: { id: "order-5" } } as never)) as Response;
    expect(res.status).toBe(422);
  });

  it("accepts a calderyn:-prefixed id, resolving to the same native order", async () => {
    seedOrder("order-5");
    const { action } = await import("../dashboard.api.orders.$id.archive");
    const res = (await action({
      request: post(`${ORIGIN}/dashboard/api/orders/calderyn:order-5/archive`, { archived: true }),
      params: { id: "calderyn:order-5" },
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(store.db.orders[0].archived_at).toBeTruthy();
  });
});
