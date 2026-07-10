// Route tests for the three bulk order-action routes (Phase 2 Task 3): fulfill, archive, tags.
// Convention mirrors dashboard.api.orders.detail.test.ts: session.server + http.server mocked
// (http.server kept REAL via importOriginal so requireSameOrigin's CSRF guard is genuinely
// exercised), executors mocked per-route, and a minimal in-memory Supabase Builder standing in
// for supabase.server for the routes (archive/tags) that go through a real shared helper.
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

const executeFulfillAction = vi.fn();
vi.mock("~/lib/order/fulfill.server", () => ({
  executeFulfillAction: (...a: unknown[]) => executeFulfillAction(...a),
}));

// Minimal in-memory Supabase stand-in for the archive/tags routes, which go through real
// shared helpers (setOrderArchived, addOrderTags) rather than a mocked executor. Deliberately
// has NO delete() method: if addOrderTags ever tried to delete a row, the Builder would throw
// with "this.delete is not a function", making an accidental full-replace regression loud.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { orders: [], order_tag: [] };

  class Builder {
    private op: "select" | "insert" | "update" = "select";
    private payload: Row | Row[] = {};
    private vals: Row = {};
    private filters: Array<[string, unknown]> = [];
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
    select(_cols?: string) {
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
    private matches(r: Row): boolean {
      return this.filters.every(([c, v]) => r[c] === v);
    }
    private run(): { data: unknown; error: unknown } {
      const t = db[this.table];
      if (this.op === "insert") {
        const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
        t.push(...rows);
        return { data: rows, error: null };
      }
      if (this.op === "update") {
        const matched = t.filter((r) => this.matches(r));
        for (const r of matched) Object.assign(r, this.vals);
        return { data: matched, error: null };
      }
      return { data: t.filter((r) => this.matches(r)), error: null };
    }
  }

  const client = { from: (table: string) => new Builder(table) };
  return { db, client };
});
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));

function seedOrder(id: string, extra: Record<string, unknown> = {}) {
  store.db.orders.push({ id, shop_id: "shop-1", archived_at: null, ...extra });
}

function post(url: string, body: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
  executeFulfillAction.mockReset();
});

describe("POST /dashboard/api/orders/bulk/fulfill", () => {
  const url = `${ORIGIN}/dashboard/api/orders/bulk/fulfill`;

  it("happy path: derives a per-order idempotency key and returns a results array", async () => {
    executeFulfillAction.mockImplementation(async (_shopId: string, input: { orderId: string }) => ({
      auditId: `audit-${input.orderId}`,
      fulfillmentId: `f-${input.orderId}`,
      orderState: "fulfilled",
      fulfilledUnits: 2,
      notified: false,
      replayed: false,
    }));

    const { action } = await import("../dashboard.api.orders.bulk.fulfill");
    const res = (await action({
      request: post(url, { order_ids: ["order-1", "order-2"], notify: false, idempotency_key: "k1" }),
      params: {},
    } as never)) as Response;

    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: unknown[] };
    expect(json.results).toEqual([
      { order_id: "order-1", ok: true, audit_id: "audit-order-1", fulfillment_id: "f-order-1", order_state: "fulfilled", fulfilled_units: 2, notified: false },
      { order_id: "order-2", ok: true, audit_id: "audit-order-2", fulfillment_id: "f-order-2", order_state: "fulfilled", fulfilled_units: 2, notified: false },
    ]);
    expect(executeFulfillAction).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ orderId: "order-1", idempotencyKey: "k1:order-1" }),
    );
    expect(executeFulfillAction).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ orderId: "order-2", idempotencyKey: "k1:order-2" }),
    );
  });

  it("one order failing never aborts the batch — the response is still 200 with a mixed results array", async () => {
    executeFulfillAction.mockImplementation(async (_shopId: string, input: { orderId: string }) => {
      if (input.orderId === "order-2") {
        const { CalderynError } = await import("~/lib/calderyn.server");
        throw new CalderynError({ code: "order_not_fulfillable", status: 409, message: "Order order-2 is 'cancelled'." });
      }
      return { auditId: "audit-1", fulfillmentId: "f1", orderState: "fulfilled", fulfilledUnits: 1, notified: false, replayed: false };
    });

    const { action } = await import("../dashboard.api.orders.bulk.fulfill");
    const res = (await action({
      request: post(url, { order_ids: ["order-1", "order-2", "order-3"], notify: false, idempotency_key: "k1" }),
      params: {},
    } as never)) as Response;

    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: Array<{ order_id: string; ok: boolean; error?: string }> };
    expect(json.results.find((r) => r.order_id === "order-1")?.ok).toBe(true);
    expect(json.results.find((r) => r.order_id === "order-2")).toEqual({
      order_id: "order-2",
      ok: false,
      error: "Order order-2 is 'cancelled'.",
    });
    expect(json.results.find((r) => r.order_id === "order-3")?.ok).toBe(true);
  });

  it("422s more than 25 order_ids without calling the executor", async () => {
    const many = Array.from({ length: 26 }, (_, i) => `order-${i}`);
    const { action } = await import("../dashboard.api.orders.bulk.fulfill");
    const res = (await action({
      request: post(url, { order_ids: many, notify: false, idempotency_key: "k1" }),
      params: {},
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("too_many_orders");
    expect(executeFulfillAction).not.toHaveBeenCalled();
  });

  it("422s a shopify:-prefixed id without calling the executor", async () => {
    const { action } = await import("../dashboard.api.orders.bulk.fulfill");
    const res = (await action({
      request: post(url, { order_ids: ["order-1", "shopify:9"], notify: false, idempotency_key: "k1" }),
      params: {},
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("imported_read_only");
    expect(executeFulfillAction).not.toHaveBeenCalled();
  });

  it("dedupes repeated order ids", async () => {
    executeFulfillAction.mockResolvedValue({
      auditId: "audit-1",
      fulfillmentId: "f1",
      orderState: "fulfilled",
      fulfilledUnits: 1,
      notified: false,
      replayed: false,
    });
    const { action } = await import("../dashboard.api.orders.bulk.fulfill");
    const res = (await action({
      request: post(url, { order_ids: ["order-1", "order-1"], notify: false, idempotency_key: "k1" }),
      params: {},
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(executeFulfillAction).toHaveBeenCalledTimes(1);
  });

  it("422s a missing idempotency_key without calling the executor", async () => {
    const { action } = await import("../dashboard.api.orders.bulk.fulfill");
    const res = (await action({
      request: post(url, { order_ids: ["order-1"], notify: false }),
      params: {},
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("missing_idempotency_key");
    expect(executeFulfillAction).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request without calling the executor", async () => {
    const { action } = await import("../dashboard.api.orders.bulk.fulfill");
    const res = await action({
      request: post(url, { order_ids: ["order-1"], notify: false, idempotency_key: "k1" }, "https://evil.example"),
      params: {},
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(executeFulfillAction).not.toHaveBeenCalled();
  });
});

describe("POST /dashboard/api/orders/bulk/archive", () => {
  const url = `${ORIGIN}/dashboard/api/orders/bulk/archive`;

  it("archives every requested order via the shared setOrderArchived helper", async () => {
    seedOrder("order-1");
    seedOrder("order-2");
    const { action } = await import("../dashboard.api.orders.bulk.archive");
    const res = (await action({
      request: post(url, { order_ids: ["order-1", "order-2"], archived: true }),
      params: {},
    } as never)) as Response;
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: Array<{ order_id: string; ok: boolean; archived?: boolean }> };
    expect(json.results).toEqual([
      { order_id: "order-1", ok: true, archived: true },
      { order_id: "order-2", ok: true, archived: true },
    ]);
    expect(store.db.orders.every((o) => o.archived_at)).toBe(true);
  });

  it("an unknown order in the batch fails only that order (200, mixed results)", async () => {
    seedOrder("order-1");
    const { action } = await import("../dashboard.api.orders.bulk.archive");
    const res = (await action({
      request: post(url, { order_ids: ["order-1", "order-missing"], archived: true }),
      params: {},
    } as never)) as Response;
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: Array<{ order_id: string; ok: boolean; error?: string }> };
    expect(json.results.find((r) => r.order_id === "order-1")?.ok).toBe(true);
    expect(json.results.find((r) => r.order_id === "order-missing")).toMatchObject({ ok: false });
  });

  it("422s an invalid archived field without writing", async () => {
    seedOrder("order-1");
    const { action } = await import("../dashboard.api.orders.bulk.archive");
    const res = (await action({
      request: post(url, { order_ids: ["order-1"], archived: "yes" }),
      params: {},
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect(store.db.orders[0].archived_at).toBeNull();
  });

  it("rejects a cross-origin request without writing", async () => {
    seedOrder("order-1");
    const { action } = await import("../dashboard.api.orders.bulk.archive");
    const res = await action({
      request: post(url, { order_ids: ["order-1"], archived: true }, "https://evil.example"),
      params: {},
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(store.db.orders[0].archived_at).toBeNull();
  });
});

describe("POST /dashboard/api/orders/bulk/tags", () => {
  const url = `${ORIGIN}/dashboard/api/orders/bulk/tags`;

  it("adds tags to every order additively (union, never a delete)", async () => {
    seedOrder("order-1");
    store.db.order_tag.push({ shop_id: "shop-1", order_id: "order-1", tag: "vip" });
    const { action } = await import("../dashboard.api.orders.bulk.tags");
    const res = (await action({
      request: post(url, { order_ids: ["order-1"], add_tags: ["Wholesale"] }),
      params: {},
    } as never)) as Response;
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: Array<{ order_id: string; ok: boolean; tags?: string[] }> };
    expect(json.results).toEqual([{ order_id: "order-1", ok: true, tags: ["vip", "wholesale"] }]);
    // never a full replace: the pre-existing "vip" row survives, plus the new "wholesale" insert.
    expect(store.db.order_tag.map((t) => t.tag).sort()).toEqual(["vip", "wholesale"]);
  });

  it("too_many_tags on one order surfaces as that order's error, others still succeed", async () => {
    seedOrder("order-1");
    seedOrder("order-2");
    for (let i = 0; i < 20; i++) store.db.order_tag.push({ shop_id: "shop-1", order_id: "order-1", tag: `tag${i}` });
    const { action } = await import("../dashboard.api.orders.bulk.tags");
    const res = (await action({
      request: post(url, { order_ids: ["order-1", "order-2"], add_tags: ["new-tag"] }),
      params: {},
    } as never)) as Response;
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: Array<{ order_id: string; ok: boolean; error?: string }> };
    expect(json.results.find((r) => r.order_id === "order-1")).toMatchObject({ ok: false });
    expect(json.results.find((r) => r.order_id === "order-2")?.ok).toBe(true);
  });

  it("422s a non-array add_tags without touching any order", async () => {
    seedOrder("order-1");
    const { action } = await import("../dashboard.api.orders.bulk.tags");
    const res = (await action({
      request: post(url, { order_ids: ["order-1"], add_tags: "vip" }),
      params: {},
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect(store.db.order_tag).toHaveLength(0);
  });

  it("rejects a cross-origin request without writing", async () => {
    seedOrder("order-1");
    const { action } = await import("../dashboard.api.orders.bulk.tags");
    const res = await action({
      request: post(url, { order_ids: ["order-1"], add_tags: ["vip"] }, "https://evil.example"),
      params: {},
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(store.db.order_tag).toHaveLength(0);
  });
});
