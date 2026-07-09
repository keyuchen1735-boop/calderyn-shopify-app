import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for the tables executeFulfillAction touches directly (orders, order_line,
// fulfillment, fulfillment_line). Mirrors the Builder pattern in checkout.server.test.ts /
// order.server.test.ts so behavior is exercised against real filter/insert/update semantics, not
// bare mocks.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { orders: [], order_line: [], fulfillment: [], fulfillment_line: [] };

  class Builder {
    private op: "select" | "insert" | "update" = "select";
    private payload: Row | Row[] = {};
    private vals: Row = {};
    private filters: Array<[string, unknown]> = [];
    private inFilters: Array<[string, unknown[]]> = [];
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
    select(_cols?: string) {
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    in(col: string, vals: unknown[]) {
      this.inFilters.push([col, vals]);
      return this;
    }
    single() {
      this.wantSingle = true;
      return this;
    }
    maybeSingle() {
      this.wantSingle = true;
      return this;
    }
    then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }

    private wrap(rows: Row[]) {
      return { data: this.wantSingle ? rows[0] ?? null : rows, error: null };
    }
    private insertOne(p: Row): Row {
      const t = db[this.table];
      const row: Row = { id: `${this.table}-${t.length + 1}`, created_at: new Date().toISOString(), ...p };
      t.push(row);
      return row;
    }
    private run(): { data: unknown; error: unknown } {
      const t = db[this.table];
      if (this.op === "insert") {
        const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((p) => this.insertOne(p));
        return this.wrap(rows);
      }
      const matches = (r: Row) =>
        this.filters.every(([c, v]) => r[c] === v) && this.inFilters.every(([c, vals]) => vals.includes(r[c]));
      if (this.op === "update") {
        const matched = t.filter(matches);
        for (const r of matched) Object.assign(r, this.vals);
        return this.wrap(matched);
      }
      const matched = t.filter(matches);
      return this.wrap(matched);
    }
  }

  const client = { from: (table: string) => new Builder(table) };
  return { db, client };
});

const h = vi.hoisted(() => ({
  prior: vi.fn(),
  insertAudit: vi.fn(),
  transitionOrder: vi.fn(),
  sendShippingConfirmation: vi.fn(),
}));

// Lightweight CalderynError so the executor's typed refusals carry code/status/message without
// loading the heavy calderyn.server module (same convention as refund-action.test.ts).
vi.mock("../calderyn.server", () => ({
  CalderynError: class extends Error {
    code: string;
    status: number;
    constructor(opts: { code: string; status: number; message: string }) {
      super(opts.message);
      this.code = opts.code;
      this.status = opts.status;
    }
  },
}));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));
vi.mock("../actions/execute.server", () => ({ priorExecutionForKey: h.prior, insertAuditWithIdempotency: h.insertAudit }));
vi.mock("./order.server", () => ({ transitionOrder: h.transitionOrder }));
vi.mock("./notify-email.server", () => ({ sendShippingConfirmation: h.sendShippingConfirmation }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { executeFulfillAction } from "./fulfill.server";

function seedOrder(shopId: string, id: string, state: string, buyerId: string | null = "buyer-1") {
  store.db.orders.push({ id, shop_id: shopId, state, buyer_id: buyerId });
}
function seedOrderLine(shopId: string, orderId: string, id: string, quantity: number) {
  store.db.order_line.push({ id, shop_id: shopId, order_id: orderId, quantity });
}

beforeEach(() => {
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
  vi.clearAllMocks();
  h.prior.mockResolvedValue(null);
  h.insertAudit.mockResolvedValue({ id: "audit-1", outcome: "succeeded" });
  h.transitionOrder.mockResolvedValue({ id: "t-1" });
  h.sendShippingConfirmation.mockResolvedValue({ sent: true, id: "email-1" });
});

describe("executeFulfillAction", () => {
  it("default (no lines given): fulfills every remaining line and transitions to fulfilled", async () => {
    seedOrder("shop-1", "order-1", "paid");
    seedOrderLine("shop-1", "order-1", "line-1", 2);
    seedOrderLine("shop-1", "order-1", "line-2", 3);

    const res = await executeFulfillAction("shop-1", { orderId: "order-1", notify: false, idempotencyKey: "k1" });

    expect(h.transitionOrder).toHaveBeenCalledWith("shop-1", "order-1", "fulfilled", expect.any(String));
    expect(res.orderState).toBe("fulfilled");
    expect(res.fulfilledUnits).toBe(5);
    expect(res.replayed).toBe(false);
    expect(res.fulfillmentId).not.toBeNull();
    expect(store.db.fulfillment).toHaveLength(1);
    expect(store.db.fulfillment[0]).toMatchObject({ status: "shipped", tracking_url: null });
    expect(store.db.fulfillment_line).toHaveLength(2);
    expect(store.db.fulfillment_line.map((l) => l.quantity).sort()).toEqual([2, 3]);

    const audit = h.insertAudit.mock.calls[0][2];
    expect(audit.action_kind).toBe("fulfill_order");
    expect(audit.write_target).toBe("owned_sot");
    expect(audit.pre_state).toEqual({ state: "paid" });
    expect(audit.post_state).toMatchObject({ state: "fulfilled" });
  });

  it("explicit partial fulfillment moves to partially_fulfilled; a second partial on the same order records rows WITHOUT a transition", async () => {
    seedOrder("shop-1", "order-2", "paid");
    seedOrderLine("shop-1", "order-2", "line-a", 5);

    const first = await executeFulfillAction("shop-1", {
      orderId: "order-2",
      lines: [{ orderLineId: "line-a", quantity: 2 }],
      notify: false,
      idempotencyKey: "k2",
    });
    expect(first.orderState).toBe("partially_fulfilled");
    expect(h.transitionOrder).toHaveBeenCalledWith("shop-1", "order-2", "partially_fulfilled", expect.any(String));

    // Simulate the state actually having moved (transitionOrder is mocked, so it doesn't touch
    // our in-memory `orders` row itself).
    store.db.orders.find((o) => o.id === "order-2")!.state = "partially_fulfilled";
    h.transitionOrder.mockClear();

    const second = await executeFulfillAction("shop-1", {
      orderId: "order-2",
      lines: [{ orderLineId: "line-a", quantity: 1 }],
      notify: false,
      idempotencyKey: "k2b",
    });
    // remaining after first partial: 5-2=3; requesting 1 leaves 2 remaining -> target stays
    // partially_fulfilled === current state -> identity move skipped.
    expect(second.orderState).toBe("partially_fulfilled");
    expect(h.transitionOrder).not.toHaveBeenCalled();
    expect(store.db.fulfillment).toHaveLength(2);
    expect(store.db.fulfillment_line).toHaveLength(2);
  });

  it("rejects an over-fulfil request with a 422-coded error, before any insert", async () => {
    seedOrder("shop-1", "order-3", "paid");
    seedOrderLine("shop-1", "order-3", "line-x", 2);

    await expect(
      executeFulfillAction("shop-1", {
        orderId: "order-3",
        lines: [{ orderLineId: "line-x", quantity: 5 }],
        notify: false,
        idempotencyKey: "k3",
      }),
    ).rejects.toMatchObject({ code: "over_fulfil", status: 422 });
    expect(store.db.fulfillment).toHaveLength(0);
    expect(h.transitionOrder).not.toHaveBeenCalled();
    expect(h.insertAudit).not.toHaveBeenCalled();
  });

  it("rejects a duplicate orderLineId in the same request with a 422-coded error, before any insert", async () => {
    seedOrder("shop-1", "order-3b", "paid");
    seedOrderLine("shop-1", "order-3b", "line-dup", 4);

    await expect(
      executeFulfillAction("shop-1", {
        orderId: "order-3b",
        lines: [
          { orderLineId: "line-dup", quantity: 2 },
          { orderLineId: "line-dup", quantity: 2 },
        ],
        notify: false,
        idempotencyKey: "k3b",
      }),
    ).rejects.toMatchObject({ code: "duplicate_line", status: 422 });
    expect(store.db.fulfillment).toHaveLength(0);
    expect(store.db.fulfillment_line).toHaveLength(0);
    expect(h.transitionOrder).not.toHaveBeenCalled();
    expect(h.insertAudit).not.toHaveBeenCalled();
  });

  it("rejects a negative quantity with a 422-coded invalid_quantity error, before any insert", async () => {
    seedOrder("shop-1", "order-3c", "paid");
    seedOrderLine("shop-1", "order-3c", "line-neg", 4);

    await expect(
      executeFulfillAction("shop-1", {
        orderId: "order-3c",
        lines: [{ orderLineId: "line-neg", quantity: -1 }],
        notify: false,
        idempotencyKey: "k3c",
      }),
    ).rejects.toMatchObject({ code: "invalid_quantity", status: 422 });
    expect(store.db.fulfillment).toHaveLength(0);
    expect(h.insertAudit).not.toHaveBeenCalled();
  });

  it("rejects a zero quantity with a 422-coded invalid_quantity error", async () => {
    seedOrder("shop-1", "order-3d", "paid");
    seedOrderLine("shop-1", "order-3d", "line-zero", 4);

    await expect(
      executeFulfillAction("shop-1", {
        orderId: "order-3d",
        lines: [{ orderLineId: "line-zero", quantity: 0 }],
        notify: false,
        idempotencyKey: "k3d",
      }),
    ).rejects.toMatchObject({ code: "invalid_quantity", status: 422 });
  });

  it("rejects a non-integer quantity with a 422-coded invalid_quantity error", async () => {
    seedOrder("shop-1", "order-3e", "paid");
    seedOrderLine("shop-1", "order-3e", "line-frac", 4);

    await expect(
      executeFulfillAction("shop-1", {
        orderId: "order-3e",
        lines: [{ orderLineId: "line-frac", quantity: 1.5 }],
        notify: false,
        idempotencyKey: "k3e",
      }),
    ).rejects.toMatchObject({ code: "invalid_quantity", status: 422 });
  });

  it("rejects a foreign order-line id with a 409-coded error", async () => {
    seedOrder("shop-1", "order-4", "paid");
    seedOrderLine("shop-1", "order-4", "line-real", 2);

    await expect(
      executeFulfillAction("shop-1", {
        orderId: "order-4",
        lines: [{ orderLineId: "line-ghost", quantity: 1 }],
        notify: false,
        idempotencyKey: "k4",
      }),
    ).rejects.toMatchObject({ code: "line_not_on_order", status: 409 });
    expect(store.db.fulfillment).toHaveLength(0);
  });

  it("replay: returns replayed:true with no inserts and no transition", async () => {
    h.prior.mockResolvedValue({ id: "audit-9", outcome: "succeeded" });
    seedOrder("shop-1", "order-5", "fulfilled");

    const res = await executeFulfillAction("shop-1", { orderId: "order-5", notify: false, idempotencyKey: "dup" });

    expect(res).toEqual({
      auditId: "audit-9",
      fulfillmentId: null,
      orderState: "fulfilled",
      fulfilledUnits: 0,
      notified: false,
      replayed: true,
    });
    expect(store.db.fulfillment).toHaveLength(0);
    expect(h.insertAudit).not.toHaveBeenCalled();
    expect(h.transitionOrder).not.toHaveBeenCalled();
  });

  it("notify:true sends the shipping confirmation and stamps fulfillment.notified_at on a confirmed send", async () => {
    seedOrder("shop-1", "order-6", "paid", "buyer-1");
    seedOrderLine("shop-1", "order-6", "line-1", 1);
    h.sendShippingConfirmation.mockResolvedValue({ sent: true, id: "email-2" });

    const res = await executeFulfillAction("shop-1", {
      orderId: "order-6",
      notify: true,
      trackingNumber: "1Z1",
      carrier: "ups",
      idempotencyKey: "k6",
    });

    expect(h.sendShippingConfirmation).toHaveBeenCalledWith("shop-1", "order-6", {
      trackingNumber: "1Z1",
      carrier: "ups",
    });
    expect(res.notified).toBe(true);
    expect(store.db.fulfillment[0].notified_at).toBeTruthy();
  });

  it("notify:true with a failed send ({sent:false}) does not stamp notified_at, and the action still succeeds", async () => {
    seedOrder("shop-1", "order-7", "paid", "buyer-1");
    seedOrderLine("shop-1", "order-7", "line-1", 1);
    h.sendShippingConfirmation.mockResolvedValue({ sent: false, error: "transport not configured" });

    const res = await executeFulfillAction("shop-1", { orderId: "order-7", notify: true, idempotencyKey: "k7" });

    expect(res.notified).toBe(false);
    expect(store.db.fulfillment[0].notified_at).toBeUndefined();
    expect(res.replayed).toBe(false);
    expect(h.insertAudit).toHaveBeenCalledTimes(1);
  });

  it("refuses to fulfill an order that isn't paid/partially_fulfilled", async () => {
    seedOrder("shop-1", "order-8", "checkout_pending");
    await expect(
      executeFulfillAction("shop-1", { orderId: "order-8", notify: false, idempotencyKey: "k8" }),
    ).rejects.toMatchObject({ code: "order_not_fulfillable", status: 409 });
  });

  it("404s a missing order", async () => {
    await expect(
      executeFulfillAction("shop-1", { orderId: "ghost", notify: false, idempotencyKey: "k9" }),
    ).rejects.toMatchObject({ code: "order_not_found", status: 404 });
  });
});
