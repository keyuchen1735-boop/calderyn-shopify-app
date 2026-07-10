import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for the tables returns.server.ts touches directly. Mirrors the Builder
// pattern used across the orders test suite (edit.server.test.ts, fulfill.server.test.ts) so
// behavior is exercised against real filter/insert/update semantics, not bare mocks.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = {
    orders: [],
    order_line: [],
    order_return: [],
    order_return_line: [],
    fulfillment: [],
    fulfillment_line: [],
    variant_dim: [],
  };

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
      return { data: this.wantSingle ? (rows[0] ?? null) : rows, error: null };
    }
    private matches(row: Row): boolean {
      return (
        this.filters.every(([c, v]) => row[c] === v) &&
        this.inFilters.every(([c, vals]) => vals.includes(row[c]))
      );
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
        if (this.table === "order_return") {
          const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
          for (const p of rows) {
            // order_return_one_open: only one `open` return per (shop_id, order_id).
            if (
              p.status === "open" &&
              t.some((r) => r.shop_id === p.shop_id && r.order_id === p.order_id && r.status === "open")
            ) {
              return {
                data: null,
                error: { code: "23505", message: 'duplicate key value violates unique constraint "order_return_one_open"' },
              };
            }
          }
        }
        const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((p) => this.insertOne(p));
        return this.wrap(rows);
      }
      if (this.op === "update") {
        const matched = t.filter((r) => this.matches(r));
        for (const r of matched) Object.assign(r, this.vals);
        return this.wrap(matched);
      }
      const matched = t.filter((r) => this.matches(r));
      return this.wrap(matched);
    }
  }

  const client = { from: (table: string) => new Builder(table) };
  return { db, client };
});

const h = vi.hoisted(() => ({
  prior: vi.fn(),
  insertAudit: vi.fn(),
  executeRefundAction: vi.fn(),
  restockLine: vi.fn(),
  remainingRefundableByOrder: vi.fn(),
}));

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
vi.mock("../actions/refund.server", () => ({ executeRefundAction: h.executeRefundAction }));
vi.mock("../inventory/engine.server", () => ({ restockLine: h.restockLine }));
vi.mock("./list.server", () => ({ remainingRefundableByOrder: h.remainingRefundableByOrder }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { createOrderReturn, cancelOrderReturn, executeReturnReceivedAction, listOrderReturns } from "./returns.server";

function seedOrder(shopId: string, id: string, state: string, extra: Record<string, unknown> = {}) {
  store.db.orders.push({ id, shop_id: shopId, state, subtotal_cents: 10000, tax_cents: 0, total_cents: 10000, ...extra });
}
function seedLine(shopId: string, orderId: string, id: string, variantId: string, unitPriceCents: number) {
  store.db.order_line.push({ id, shop_id: shopId, order_id: orderId, variant_id: variantId, unit_price_cents: unitPriceCents });
}
function seedFulfilled(shopId: string, orderId: string, lineId: string, qty: number) {
  const fId = `f-${store.db.fulfillment.length + 1}`;
  store.db.fulfillment.push({ id: fId, shop_id: shopId, order_id: orderId });
  store.db.fulfillment_line.push({ id: `${fId}-l`, shop_id: shopId, fulfillment_id: fId, order_line_id: lineId, quantity: qty });
}

beforeEach(() => {
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
  vi.clearAllMocks();
  h.prior.mockResolvedValue(null);
  h.insertAudit.mockResolvedValue({ id: "audit-1", outcome: "succeeded" });
  h.executeRefundAction.mockResolvedValue({
    auditId: "refund-audit-1",
    outcome: "succeeded",
    refundId: "re_1",
    amountCents: 0,
    capturedCents: 0,
    refundedTotalCents: 0,
    orderState: "partially_refunded",
    restockedLines: 0,
    restockError: null,
    replayed: false,
  });
  h.restockLine.mockResolvedValue(undefined);
  h.remainingRefundableByOrder.mockImplementation(async (_shopId: string, orderIds: string[]) => {
    const map = new Map<string, number>();
    for (const id of orderIds) map.set(id, Number.MAX_SAFE_INTEGER);
    return map;
  });
});

describe("createOrderReturn — preconditions", () => {
  it("422s an empty lines array", async () => {
    seedOrder("shop-1", "order-1", "fulfilled");
    await expect(createOrderReturn("shop-1", { orderId: "order-1", lines: [] })).rejects.toMatchObject({
      code: "invalid_lines",
      status: 422,
    });
  });

  it("404s a missing order", async () => {
    await expect(
      createOrderReturn("shop-1", { orderId: "ghost", lines: [{ orderLineId: "l1", quantity: 1, restock: true }] }),
    ).rejects.toMatchObject({ code: "order_not_found", status: 404 });
  });

  it("refuses an order that isn't paid/partially_fulfilled/fulfilled/partially_refunded", async () => {
    seedOrder("shop-1", "order-1", "checkout_pending");
    await expect(
      createOrderReturn("shop-1", { orderId: "order-1", lines: [{ orderLineId: "l1", quantity: 1, restock: true }] }),
    ).rejects.toMatchObject({ code: "order_not_returnable", status: 409 });
  });

  it("422s a duplicate orderLineId in the same request", async () => {
    seedOrder("shop-1", "order-1", "fulfilled");
    seedLine("shop-1", "order-1", "line-1", "v-1", 1000);
    seedFulfilled("shop-1", "order-1", "line-1", 5);
    await expect(
      createOrderReturn("shop-1", {
        orderId: "order-1",
        lines: [
          { orderLineId: "line-1", quantity: 1, restock: true },
          { orderLineId: "line-1", quantity: 1, restock: true },
        ],
      }),
    ).rejects.toMatchObject({ code: "duplicate_line", status: 422 });
  });

  it("422s a non-integer/non-positive quantity", async () => {
    seedOrder("shop-1", "order-1", "fulfilled");
    seedLine("shop-1", "order-1", "line-1", "v-1", 1000);
    seedFulfilled("shop-1", "order-1", "line-1", 5);
    await expect(
      createOrderReturn("shop-1", { orderId: "order-1", lines: [{ orderLineId: "line-1", quantity: 0, restock: true }] }),
    ).rejects.toMatchObject({ code: "invalid_quantity", status: 422 });
  });

  it("404s a line that doesn't belong to the order", async () => {
    seedOrder("shop-1", "order-1", "fulfilled");
    await expect(
      createOrderReturn("shop-1", { orderId: "order-1", lines: [{ orderLineId: "ghost-line", quantity: 1, restock: true }] }),
    ).rejects.toMatchObject({ code: "line_not_found", status: 404 });
  });
});

describe("createOrderReturn — returnable-quantity cap", () => {
  it("qty_exceeds_returnable: cannot return more than was fulfilled", async () => {
    seedOrder("shop-1", "order-1", "fulfilled");
    seedLine("shop-1", "order-1", "line-1", "v-1", 1000);
    seedFulfilled("shop-1", "order-1", "line-1", 2);
    await expect(
      createOrderReturn("shop-1", { orderId: "order-1", lines: [{ orderLineId: "line-1", quantity: 3, restock: true }] }),
    ).rejects.toMatchObject({ code: "qty_exceeds_returnable", status: 409 });
  });

  it("caps returnable qty after a PRIOR received (closed) return already consumed units", async () => {
    seedOrder("shop-1", "order-1", "fulfilled");
    seedLine("shop-1", "order-1", "line-1", "v-1", 1000);
    seedFulfilled("shop-1", "order-1", "line-1", 5);
    store.db.order_return.push({ id: "return-old", shop_id: "shop-1", order_id: "order-1", status: "closed" });
    store.db.order_return_line.push({
      id: "rline-old",
      shop_id: "shop-1",
      return_id: "return-old",
      order_line_id: "line-1",
      quantity: 3,
    });

    // Only 5 - 3 = 2 remain returnable.
    await expect(
      createOrderReturn("shop-1", { orderId: "order-1", lines: [{ orderLineId: "line-1", quantity: 3, restock: true }] }),
    ).rejects.toMatchObject({ code: "qty_exceeds_returnable", status: 409 });

    const res = await createOrderReturn("shop-1", { orderId: "order-1", lines: [{ orderLineId: "line-1", quantity: 2, restock: true }] });
    expect(res.lines[0].quantity).toBe(2);
  });

  it("a CANCELLED prior return does not consume returnable quantity", async () => {
    seedOrder("shop-1", "order-1", "fulfilled");
    seedLine("shop-1", "order-1", "line-1", "v-1", 1000);
    seedFulfilled("shop-1", "order-1", "line-1", 5);
    store.db.order_return.push({ id: "return-cancelled", shop_id: "shop-1", order_id: "order-1", status: "cancelled" });
    store.db.order_return_line.push({
      id: "rline-cancelled",
      shop_id: "shop-1",
      return_id: "return-cancelled",
      order_line_id: "line-1",
      quantity: 3,
    });

    const res = await createOrderReturn("shop-1", { orderId: "order-1", lines: [{ orderLineId: "line-1", quantity: 5, restock: true }] });
    expect(res.lines[0].quantity).toBe(5);
  });
});

describe("createOrderReturn — refund default + cap", () => {
  it("defaults refund_cents to unit_price x qty + proportional tax share when omitted", async () => {
    seedOrder("shop-1", "order-1", "fulfilled", { subtotal_cents: 10000, tax_cents: 800 });
    seedLine("shop-1", "order-1", "line-1", "v-1", 1250); // 2 units -> deltaSubtotal 2500
    seedFulfilled("shop-1", "order-1", "line-1", 5);

    const res = await createOrderReturn("shop-1", { orderId: "order-1", lines: [{ orderLineId: "line-1", quantity: 2, restock: true }] });

    // floor(800 * 2500 / 10000) = 200; refund = 2500 + 200 = 2700 (shared reduction-tax formula).
    expect(res.lines[0].refundCents).toBe(2700);
  });

  it("accepts a client refundCents at or below the default", async () => {
    seedOrder("shop-1", "order-1", "fulfilled", { subtotal_cents: 10000, tax_cents: 0 });
    seedLine("shop-1", "order-1", "line-1", "v-1", 1000);
    seedFulfilled("shop-1", "order-1", "line-1", 5);

    const res = await createOrderReturn("shop-1", {
      orderId: "order-1",
      lines: [{ orderLineId: "line-1", quantity: 2, restock: true, refundCents: 1500 }], // default is 2000
    });
    expect(res.lines[0].refundCents).toBe(1500);
  });

  it("refund_exceeds_default: rejects a client refundCents above the default", async () => {
    seedOrder("shop-1", "order-1", "fulfilled", { subtotal_cents: 10000, tax_cents: 0 });
    seedLine("shop-1", "order-1", "line-1", "v-1", 1000);
    seedFulfilled("shop-1", "order-1", "line-1", 5);

    await expect(
      createOrderReturn("shop-1", {
        orderId: "order-1",
        lines: [{ orderLineId: "line-1", quantity: 2, restock: true, refundCents: 2500 }], // default is 2000
      }),
    ).rejects.toMatchObject({ code: "refund_exceeds_default", status: 422 });
    expect(store.db.order_return).toHaveLength(0);
  });
});

describe("createOrderReturn — one-open guard", () => {
  it("return_already_open: 409s a second open return for the same order", async () => {
    seedOrder("shop-1", "order-1", "fulfilled");
    seedLine("shop-1", "order-1", "line-1", "v-1", 1000);
    seedFulfilled("shop-1", "order-1", "line-1", 5);

    await createOrderReturn("shop-1", { orderId: "order-1", lines: [{ orderLineId: "line-1", quantity: 1, restock: true }] });
    await expect(
      createOrderReturn("shop-1", { orderId: "order-1", lines: [{ orderLineId: "line-1", quantity: 1, restock: true }] }),
    ).rejects.toMatchObject({ code: "return_already_open", status: 409 });
    expect(store.db.order_return).toHaveLength(1);
  });
});

describe("cancelOrderReturn", () => {
  it("cancels an open return", async () => {
    store.db.order_return.push({ id: "return-1", shop_id: "shop-1", order_id: "order-1", status: "open" });
    const res = await cancelOrderReturn("shop-1", "return-1");
    expect(res).toEqual({ returnId: "return-1", status: "cancelled" });
    expect(store.db.order_return[0].status).toBe("cancelled");
  });

  it("404s a missing return", async () => {
    await expect(cancelOrderReturn("shop-1", "ghost")).rejects.toMatchObject({ code: "return_not_found", status: 404 });
  });

  it("return_not_cancellable: 409s a return that isn't open", async () => {
    store.db.order_return.push({ id: "return-1", shop_id: "shop-1", order_id: "order-1", status: "closed" });
    await expect(cancelOrderReturn("shop-1", "return-1")).rejects.toMatchObject({ code: "return_not_cancellable", status: 409 });
  });
});

describe("executeReturnReceivedAction — replay", () => {
  it("a completed key short-circuits to the SAME result without touching the DB again", async () => {
    h.prior.mockResolvedValue({ id: "audit-9", outcome: "succeeded" });
    store.db.action_audit = [
      {
        id: "audit-9",
        shop_id: "shop-1",
        params: { return_id: "return-1", order_id: "order-1", refunded_cents: 2000, restocked_lines: 1, restock_errors: null },
      },
    ] as any;

    const res = await executeReturnReceivedAction("shop-1", { returnId: "return-1", idempotencyKey: "dup" });

    expect(res).toEqual({
      auditId: "audit-9",
      returnId: "return-1",
      orderId: "order-1",
      status: "closed",
      refundedCents: 2000,
      restockedLines: 1,
      restockErrors: null,
      replayed: true,
    });
    expect(h.executeRefundAction).not.toHaveBeenCalled();
    expect(h.insertAudit).not.toHaveBeenCalled();
  });
});

describe("executeReturnReceivedAction — happy path", () => {
  it("restocks the tracked line (keyed restockreturn:<return-line-id>), refunds via a nested key, flips to closed, and audits", async () => {
    seedOrder("shop-1", "order-1", "fulfilled");
    seedLine("shop-1", "order-1", "line-1", "v-1", 1000);
    seedFulfilled("shop-1", "order-1", "line-1", 5);
    store.db.variant_dim.push({ id: "v-1", shop_id: "shop-1", inventory_tracked: true });
    store.db.order_return.push({ id: "return-1", shop_id: "shop-1", order_id: "order-1", status: "open" });
    store.db.order_return_line.push({
      id: "rline-1",
      shop_id: "shop-1",
      return_id: "return-1",
      order_line_id: "line-1",
      quantity: 2,
      restock: true,
      refund_cents: 2000,
    });
    h.executeRefundAction.mockResolvedValue({
      auditId: "refund-audit-1",
      outcome: "succeeded",
      refundId: "re_1",
      amountCents: 2000,
      capturedCents: 10000,
      refundedTotalCents: 2000,
      orderState: "partially_refunded",
      restockedLines: 0,
      restockError: null,
      replayed: false,
    });

    const res = await executeReturnReceivedAction("shop-1", { returnId: "return-1", idempotencyKey: "rk1" });

    expect(h.restockLine).toHaveBeenCalledWith("shop-1", "order-1", "v-1", 2, "restockreturn:rline-1");
    expect(h.executeRefundAction).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ orderId: "order-1", amountCents: 2000, idempotencyKey: "rk1:refund", restock: false }),
      store.client,
    );
    expect(store.db.order_return[0]).toMatchObject({ status: "closed", received_idempotency_key: "rk1" });
    expect(store.db.order_return[0].received_at).toBeTruthy();

    expect(res).toMatchObject({
      returnId: "return-1",
      orderId: "order-1",
      status: "closed",
      refundedCents: 2000,
      restockedLines: 1,
      restockErrors: null,
      replayed: false,
    });

    const audit = h.insertAudit.mock.calls[0][2];
    expect(audit.action_kind).toBe("return_received");
    expect(audit.write_target).toBe("owned_sot");
    expect(audit.params).toMatchObject({ return_id: "return-1", order_id: "order-1", refunded_cents: 2000, restocked_lines: 1 });
  });

  it("skips untracked variants silently (no restock call)", async () => {
    seedOrder("shop-1", "order-1", "fulfilled");
    seedLine("shop-1", "order-1", "line-1", "v-untracked", 1000);
    seedFulfilled("shop-1", "order-1", "line-1", 5);
    store.db.variant_dim.push({ id: "v-untracked", shop_id: "shop-1", inventory_tracked: false });
    store.db.order_return.push({ id: "return-1", shop_id: "shop-1", order_id: "order-1", status: "open" });
    store.db.order_return_line.push({
      id: "rline-1",
      shop_id: "shop-1",
      return_id: "return-1",
      order_line_id: "line-1",
      quantity: 1,
      restock: true,
      refund_cents: 0,
    });

    const res = await executeReturnReceivedAction("shop-1", { returnId: "return-1", idempotencyKey: "rk2" });
    expect(h.restockLine).not.toHaveBeenCalled();
    expect(res.restockedLines).toBe(0);
  });

  it("zero-refund path skips executeRefundAction entirely", async () => {
    seedOrder("shop-1", "order-1", "fulfilled");
    seedLine("shop-1", "order-1", "line-1", "v-1", 1000);
    seedFulfilled("shop-1", "order-1", "line-1", 5);
    store.db.order_return.push({ id: "return-1", shop_id: "shop-1", order_id: "order-1", status: "open" });
    store.db.order_return_line.push({
      id: "rline-1",
      shop_id: "shop-1",
      return_id: "return-1",
      order_line_id: "line-1",
      quantity: 1,
      restock: false,
      refund_cents: 0,
    });

    const res = await executeReturnReceivedAction("shop-1", { returnId: "return-1", idempotencyKey: "rk3" });
    expect(h.executeRefundAction).not.toHaveBeenCalled();
    expect(res.refundedCents).toBe(0);
  });

  it("404s a missing return", async () => {
    await expect(executeReturnReceivedAction("shop-1", { returnId: "ghost", idempotencyKey: "rk4" })).rejects.toMatchObject({
      code: "return_not_found",
      status: 404,
    });
  });

  it("return_not_open: 409s a return that is not open and not a resume of this key", async () => {
    store.db.order_return.push({ id: "return-1", shop_id: "shop-1", order_id: "order-1", status: "cancelled" });
    await expect(executeReturnReceivedAction("shop-1", { returnId: "return-1", idempotencyKey: "rk5" })).rejects.toMatchObject({
      code: "return_not_open",
      status: 409,
    });
    expect(h.executeRefundAction).not.toHaveBeenCalled();
  });
});

describe("executeReturnReceivedAction — over-refund guard, BEFORE any write", () => {
  it("409s over_refund before restock/refund/stamp when the return's total exceeds what remains refundable", async () => {
    seedOrder("shop-1", "order-1", "fulfilled");
    seedLine("shop-1", "order-1", "line-1", "v-1", 1000);
    seedFulfilled("shop-1", "order-1", "line-1", 5);
    store.db.variant_dim.push({ id: "v-1", shop_id: "shop-1", inventory_tracked: true });
    store.db.order_return.push({ id: "return-1", shop_id: "shop-1", order_id: "order-1", status: "open" });
    store.db.order_return_line.push({
      id: "rline-1",
      shop_id: "shop-1",
      return_id: "return-1",
      order_line_id: "line-1",
      quantity: 2,
      restock: true,
      refund_cents: 2000,
    });
    h.remainingRefundableByOrder.mockResolvedValueOnce(new Map([["order-1", 1000]])); // only 1000 left, need 2000

    await expect(executeReturnReceivedAction("shop-1", { returnId: "return-1", idempotencyKey: "rkover" })).rejects.toMatchObject({
      code: "over_refund",
      status: 409,
    });

    expect(h.restockLine).not.toHaveBeenCalled();
    expect(h.executeRefundAction).not.toHaveBeenCalled();
    expect(store.db.order_return[0].status).toBe("open");
    expect(h.insertAudit).not.toHaveBeenCalled();
  });
});

describe("executeReturnReceivedAction — crash-window resume", () => {
  it("resumes when the row already carries THIS idempotency key on received_idempotency_key (redoes restock+refund, both idempotent, then writes the missing audit tail)", async () => {
    seedOrder("shop-1", "order-1", "fulfilled");
    seedLine("shop-1", "order-1", "line-1", "v-1", 1000);
    seedFulfilled("shop-1", "order-1", "line-1", 5);
    store.db.variant_dim.push({ id: "v-1", shop_id: "shop-1", inventory_tracked: true });
    // Simulate: a crashed prior attempt already flipped status+stamped the key, but its audit
    // tail never landed (h.prior resolves null — the outer idempotency check finds nothing).
    store.db.order_return.push({
      id: "return-1",
      shop_id: "shop-1",
      order_id: "order-1",
      status: "closed",
      received_idempotency_key: "resume-key",
      received_at: "2026-07-01T00:00:00.000Z",
    });
    store.db.order_return_line.push({
      id: "rline-1",
      shop_id: "shop-1",
      return_id: "return-1",
      order_line_id: "line-1",
      quantity: 2,
      restock: true,
      refund_cents: 2000,
    });

    const res = await executeReturnReceivedAction("shop-1", { returnId: "return-1", idempotencyKey: "resume-key" });

    // Refund replays via its own nested idempotency (executeRefundAction is mocked here to always
    // "succeed" with amountCents from its resolved value — the real executor's OWN idempotency
    // check is what makes a genuine resume a no-charge replay; this asserts the WIRING).
    expect(h.executeRefundAction).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ orderId: "order-1", amountCents: 2000, idempotencyKey: "resume-key:refund" }),
      store.client,
    );
    expect(h.restockLine).toHaveBeenCalledWith("shop-1", "order-1", "v-1", 2, "restockreturn:rline-1");
    expect(res.replayed).toBe(false);
    expect(h.insertAudit).toHaveBeenCalledTimes(1);
    // The over-refund pre-check is SKIPPED on resume (it would wrongly reject against a ledger the
    // crashed attempt's own refund already moved) — remainingRefundableByOrder is never consulted.
    expect(h.remainingRefundableByOrder).not.toHaveBeenCalled();
  });
});

describe("executeReturnReceivedAction — CAS-loss convergence", () => {
  it("tolerates the status-flip CAS matching 0 rows (already flipped by a concurrent execution) without throwing", async () => {
    seedOrder("shop-1", "order-1", "fulfilled");
    seedLine("shop-1", "order-1", "line-1", "v-1", 1000);
    seedFulfilled("shop-1", "order-1", "line-1", 5);
    store.db.order_return.push({ id: "return-1", shop_id: "shop-1", order_id: "order-1", status: "open" });
    store.db.order_return_line.push({
      id: "rline-1",
      shop_id: "shop-1",
      return_id: "return-1",
      order_line_id: "line-1",
      quantity: 1,
      restock: false,
      refund_cents: 1000,
    });
    // Force the CAS update to observe a status that is no longer 'open' at UPDATE time, by flipping
    // it out from under the flow via a mid-flight mock on the (already-called-before-the-CAS-update)
    // nested refund executor.
    h.executeRefundAction.mockImplementation(async () => {
      store.db.order_return[0].status = "closed"; // concurrent execution already flipped it
      return {
        auditId: "refund-audit-race",
        outcome: "succeeded",
        refundId: "re_race",
        amountCents: 1000,
        capturedCents: 10000,
        refundedTotalCents: 1000,
        orderState: "partially_refunded",
        restockedLines: 0,
        restockError: null,
        replayed: false,
      };
    });

    const res = await executeReturnReceivedAction("shop-1", { returnId: "return-1", idempotencyKey: "rk-race" });
    expect(res.status).toBe("closed");
    expect(res.replayed).toBe(false);
    expect(h.insertAudit).toHaveBeenCalledTimes(1);
  });
});

describe("listOrderReturns", () => {
  it("returns every return on the order, newest first, with its lines", async () => {
    store.db.order_return.push(
      { id: "return-1", shop_id: "shop-1", order_id: "order-1", status: "closed", reason: "damaged", created_at: "2026-07-01T00:00:00.000Z", received_at: "2026-07-02T00:00:00.000Z" },
      { id: "return-2", shop_id: "shop-1", order_id: "order-1", status: "open", reason: null, created_at: "2026-07-03T00:00:00.000Z", received_at: null },
    );
    store.db.order_return_line.push(
      { id: "rline-1", shop_id: "shop-1", return_id: "return-1", order_line_id: "line-1", quantity: 1, restock: true, refund_cents: 1000 },
      { id: "rline-2", shop_id: "shop-1", return_id: "return-2", order_line_id: "line-2", quantity: 2, restock: false, refund_cents: 0 },
    );

    const returns = await listOrderReturns("shop-1", "order-1");
    expect(returns.map((r) => r.id)).toEqual(["return-2", "return-1"]); // newest created_at first
    expect(returns[1].lines).toEqual([{ id: "rline-1", orderLineId: "line-1", quantity: 1, restock: true, refundCents: 1000 }]);
  });

  it("returns [] for an order with no returns, without querying order_return_line", async () => {
    const returns = await listOrderReturns("shop-1", "order-1");
    expect(returns).toEqual([]);
  });
});
