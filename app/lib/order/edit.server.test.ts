import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for the tables executeReduceLineAction/executeEditInvoiceLines touch
// directly. Mirrors the Builder pattern used across the orders test suite (fulfill.server.test.ts,
// detail.server.test.ts) so behavior is exercised against real filter/insert/update/delete
// semantics, not bare mocks.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = {
    orders: [],
    order_line: [],
    order_line_edit: [],
    fulfillment_line: [],
    variant_dim: [],
  };
  // Set by a test to simulate a genuinely concurrent order_line_edit commit landing between this
  // executor's own read (currentEffective) and its own insert — consumed once, on the next insert
  // into order_line_edit, so the DB-level uniqueness guards can be exercised without a real race.
  const race: { row: Row | null } = { row: null };

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
      return this.filters.every(([c, v]) => row[c] === v);
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
        if (this.table === "order_line_edit") {
          // A test-armed race: land the "concurrent" commit now, right before checking OUR own
          // insert for conflicts — mirrors a genuinely concurrent request's insert landing in the
          // window between this executor's read and its own insert.
          if (race.row) {
            const injected = { id: `order_line_edit-${t.length + 1}`, created_at: new Date().toISOString(), ...race.row };
            t.push(injected);
            race.row = null;
          }
          const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
          for (const p of rows) {
            // Unique index on (shop_id, idempotency_key).
            if (
              p.idempotency_key &&
              t.some((r) => r.shop_id === p.shop_id && r.idempotency_key === p.idempotency_key)
            ) {
              return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
            }
            // Unique index order_line_edit_baseline on (shop_id, order_line_id, old_quantity) —
            // migration 20260710190000: old_quantity strictly decreases along a line's edit chain,
            // so a repeat of (line, old_quantity) can only be a concurrent duplicate.
            if (
              t.some(
                (r) =>
                  r.shop_id === p.shop_id &&
                  r.order_line_id === p.order_line_id &&
                  r.old_quantity === p.old_quantity,
              )
            ) {
              return {
                data: null,
                error: { code: "23505", message: 'duplicate key value violates unique constraint "order_line_edit_baseline"' },
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
      if (this.op === "delete") {
        const keep = t.filter((r) => !this.matches(r));
        const removed = t.filter((r) => this.matches(r));
        db[this.table] = keep;
        return this.wrap(removed);
      }
      const matched = t.filter((r) => this.matches(r));
      return this.wrap(matched);
    }
  }

  const client = { from: (table: string) => new Builder(table) };
  return { db, client, race };
});

const h = vi.hoisted(() => ({
  prior: vi.fn(),
  insertAudit: vi.fn(),
  executeRefundAction: vi.fn(),
  restockLine: vi.fn(),
  priceLines: vi.fn(),
  quoteCart: vi.fn(),
  loadDefaultShippingAddress: vi.fn(),
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
vi.mock("./cart.server", () => ({ priceLines: h.priceLines }));
vi.mock("~/lib/commerce/quote.server", () => ({ quoteCart: h.quoteCart }));
vi.mock("./detail.server", () => ({ loadDefaultShippingAddress: h.loadDefaultShippingAddress }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { executeReduceLineAction, executeEditInvoiceLines } from "./edit.server";
// eslint-disable-next-line import/first -- same as above; dependency-free, not mocked
import { ShipRestrictedError } from "~/lib/shipping/errors";

function seedOrder(shopId: string, id: string, state: string, extra: Record<string, unknown> = {}) {
  store.db.orders.push({ id, shop_id: shopId, state, ...extra });
}
function seedLine(shopId: string, orderId: string, id: string, variantId: string, quantity: number, unitPriceCents: number) {
  store.db.order_line.push({ id, shop_id: shopId, order_id: orderId, variant_id: variantId, quantity, unit_price_cents: unitPriceCents });
}

beforeEach(() => {
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
  store.race.row = null;
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
});

describe("executeReduceLineAction — preconditions", () => {
  it("rejects a non-integer/negative newQuantity before any read", async () => {
    await expect(
      executeReduceLineAction("shop-1", { orderId: "o1", orderLineId: "l1", newQuantity: -1, restock: false, idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ code: "invalid_quantity", status: 422 });
    expect(h.prior).not.toHaveBeenCalled();
  });

  it("404s a missing order", async () => {
    await expect(
      executeReduceLineAction("shop-1", { orderId: "ghost", orderLineId: "l1", newQuantity: 1, restock: false, idempotencyKey: "k2" }),
    ).rejects.toMatchObject({ code: "order_not_found", status: 404 });
  });

  it("refuses an order that isn't paid/partially_fulfilled/fulfilled", async () => {
    seedOrder("shop-1", "order-1", "checkout_pending");
    seedLine("shop-1", "order-1", "line-1", "v-1", 5, 1000);
    await expect(
      executeReduceLineAction("shop-1", { orderId: "order-1", orderLineId: "line-1", newQuantity: 1, restock: false, idempotencyKey: "k3" }),
    ).rejects.toMatchObject({ code: "order_not_editable", status: 409 });
  });

  it("404s an order line that doesn't belong to the order", async () => {
    seedOrder("shop-1", "order-1", "paid");
    seedLine("shop-1", "order-1", "line-1", "v-1", 5, 1000);
    await expect(
      executeReduceLineAction("shop-1", { orderId: "order-1", orderLineId: "line-ghost", newQuantity: 1, restock: false, idempotencyKey: "k4" }),
    ).rejects.toMatchObject({ code: "line_not_found", status: 404 });
  });

  it("nothing_to_reduce: newQuantity equal to or above the current effective quantity", async () => {
    seedOrder("shop-1", "order-1", "paid");
    seedLine("shop-1", "order-1", "line-1", "v-1", 5, 1000);
    await expect(
      executeReduceLineAction("shop-1", { orderId: "order-1", orderLineId: "line-1", newQuantity: 5, restock: false, idempotencyKey: "k5" }),
    ).rejects.toMatchObject({ code: "nothing_to_reduce", status: 422 });
    await expect(
      executeReduceLineAction("shop-1", { orderId: "order-1", orderLineId: "line-1", newQuantity: 7, restock: false, idempotencyKey: "k5b" }),
    ).rejects.toMatchObject({ code: "nothing_to_reduce", status: 422 });
    expect(store.db.order_line_edit).toHaveLength(0);
  });

  it("below_fulfilled: cannot reduce below what's already shipped", async () => {
    seedOrder("shop-1", "order-1", "partially_fulfilled");
    seedLine("shop-1", "order-1", "line-1", "v-1", 5, 1000);
    store.db.fulfillment_line.push({ id: "fl-1", shop_id: "shop-1", order_line_id: "line-1", quantity: 3 });
    await expect(
      executeReduceLineAction("shop-1", { orderId: "order-1", orderLineId: "line-1", newQuantity: 2, restock: false, idempotencyKey: "k6" }),
    ).rejects.toMatchObject({ code: "below_fulfilled", status: 409 });
    expect(store.db.order_line_edit).toHaveLength(0);
  });
});

describe("executeReduceLineAction — happy path", () => {
  it("writes the edit row, refunds the exact delta, restocks the tracked variant, and audits with edit_order", async () => {
    seedOrder("shop-1", "order-1", "paid");
    seedLine("shop-1", "order-1", "line-1", "v-1", 5, 1000); // 5 units @ $10.00
    store.db.variant_dim.push({ id: "v-1", shop_id: "shop-1", inventory_tracked: true });
    h.executeRefundAction.mockResolvedValue({
      auditId: "refund-audit-1",
      outcome: "succeeded",
      refundId: "re_1",
      amountCents: 2000,
      capturedCents: 5000,
      refundedTotalCents: 2000,
      orderState: "partially_refunded",
      restockedLines: 0,
      restockError: null,
      replayed: false,
    });

    const res = await executeReduceLineAction("shop-1", {
      orderId: "order-1",
      orderLineId: "line-1",
      newQuantity: 3,
      restock: true,
      reason: "buyer asked for fewer",
      idempotencyKey: "k7",
    });

    expect(store.db.order_line_edit).toHaveLength(1);
    expect(store.db.order_line_edit[0]).toMatchObject({
      old_quantity: 5,
      new_quantity: 3,
      refund_cents: 2000, // delta 2 * $10.00
      idempotency_key: "k7",
    });

    // Refund delegated to the shared executor with a NESTED key, restock:false (handled here).
    expect(h.executeRefundAction).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ orderId: "order-1", amountCents: 2000, idempotencyKey: "k7:refund", restock: false }),
      store.client,
    );

    // Restock called with the edit-row-derived key — one row, one restock.
    const editRowId = store.db.order_line_edit[0].id;
    expect(h.restockLine).toHaveBeenCalledWith("shop-1", "order-1", "v-1", 2, `editrestock:${editRowId}`);

    expect(res).toMatchObject({
      orderState: "partially_refunded",
      refundedCents: 2000,
      restocked: true,
      restockError: null,
      replayed: false,
    });

    const audit = h.insertAudit.mock.calls[0][2];
    expect(audit.action_kind).toBe("edit_order");
    expect(audit.write_target).toBe("owned_sot");
    expect(audit.params).toMatchObject({
      order_id: "order-1",
      order_line_id: "line-1",
      old_quantity: 5,
      new_quantity: 3,
      refund_cents: 2000,
      restock_requested: true,
      restocked: true,
    });
  });

  it("skips untracked variants silently (no restock call), still succeeds", async () => {
    seedOrder("shop-1", "order-1", "paid");
    seedLine("shop-1", "order-1", "line-1", "v-untracked", 5, 1000);
    store.db.variant_dim.push({ id: "v-untracked", shop_id: "shop-1", inventory_tracked: false });
    h.executeRefundAction.mockResolvedValue({
      auditId: "r1",
      outcome: "succeeded",
      refundId: "re_2",
      amountCents: 3000,
      capturedCents: 5000,
      refundedTotalCents: 3000,
      orderState: "partially_refunded",
      restockedLines: 0,
      restockError: null,
      replayed: false,
    });

    const res = await executeReduceLineAction("shop-1", {
      orderId: "order-1",
      orderLineId: "line-1",
      newQuantity: 2,
      restock: true,
      idempotencyKey: "k8",
    });

    expect(h.restockLine).not.toHaveBeenCalled();
    expect(res.restocked).toBe(false);
  });

  it("zero-price line: no refund call, but the edit row still records the reduction", async () => {
    seedOrder("shop-1", "order-1", "paid");
    seedLine("shop-1", "order-1", "line-1", "v-free", 5, 0);

    const res = await executeReduceLineAction("shop-1", {
      orderId: "order-1",
      orderLineId: "line-1",
      newQuantity: 2,
      restock: false,
      idempotencyKey: "k9",
    });

    expect(h.executeRefundAction).not.toHaveBeenCalled();
    expect(res.refundedCents).toBe(0);
    expect(store.db.order_line_edit[0].refund_cents).toBe(0);
  });

  it("chained edits (5->3 then 3->1): the second edit's old_quantity is 3, and the partially_refunded state the first refund left behind stays editable", async () => {
    seedOrder("shop-1", "order-1", "paid");
    seedLine("shop-1", "order-1", "line-1", "v-1", 5, 1000);

    await executeReduceLineAction("shop-1", { orderId: "order-1", orderLineId: "line-1", newQuantity: 3, restock: false, idempotencyKey: "k10a" });
    // The first reduction's nested refund transitions the REAL order to partially_refunded —
    // simulate that here (executeRefundAction is mocked, so it never touches the fake row
    // itself). A second reduction must still be allowed, or the feature locks out after one use.
    store.db.orders.find((o) => o.id === "order-1")!.state = "partially_refunded";
    const second = await executeReduceLineAction("shop-1", { orderId: "order-1", orderLineId: "line-1", newQuantity: 1, restock: false, idempotencyKey: "k10b" });

    expect(store.db.order_line_edit).toHaveLength(2);
    expect(store.db.order_line_edit[0]).toMatchObject({ old_quantity: 5, new_quantity: 3 });
    expect(store.db.order_line_edit[1]).toMatchObject({ old_quantity: 3, new_quantity: 1 });
    expect(second.replayed).toBe(false);
  });

  it("restock=true with a failing variant_dim read degrades to restockError instead of throwing past the audit tail", async () => {
    seedOrder("shop-1", "order-1", "paid");
    seedLine("shop-1", "order-1", "line-1", "v-ghost", 5, 1000); // no variant_dim row seeded
    // The fake store returns { data: null, error: null } for a missing row (maybeSingle), which
    // reads as "untracked" — to exercise the ERROR path we seed a poisoned row the builder
    // cannot represent; instead, simulate via a variant_dim row and a broken restockLine seam:
    store.db.variant_dim.push({ id: "v-ghost", shop_id: "shop-1", inventory_tracked: true });
    h.restockLine.mockRejectedValue(new Error("rpc unavailable"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await executeReduceLineAction("shop-1", {
        orderId: "order-1",
        orderLineId: "line-1",
        newQuantity: 3,
        restock: true,
        idempotencyKey: "k10c",
      });
      // The action still completes: audit row written, restock failure surfaced, not thrown.
      expect(res.restocked).toBe(false);
      expect(res.restockError).toBe("rpc unavailable");
      expect(h.insertAudit).toHaveBeenCalledTimes(1);
      expect(h.insertAudit.mock.calls[0][2].params.restock_error).toBe("rpc unavailable");
    } finally {
      consoleErr.mockRestore();
    }
  });

  it("replay: a completed key short-circuits to the SAME result without touching the DB again", async () => {
    h.prior.mockResolvedValue({ id: "audit-9", outcome: "succeeded" });
    store.db.action_audit = [
      {
        id: "audit-9",
        shop_id: "shop-1",
        params: { refunded_cents: 2000, restocked: true, restock_error: null },
        post_state: { state: "partially_refunded" },
      },
    ];

    const res = await executeReduceLineAction("shop-1", {
      orderId: "order-1",
      orderLineId: "line-1",
      newQuantity: 3,
      restock: true,
      idempotencyKey: "dup",
    });

    expect(res).toEqual({
      auditId: "audit-9",
      orderState: "partially_refunded",
      refundedCents: 2000,
      restocked: true,
      restockError: null,
      replayed: true,
    });
    expect(store.db.order_line_edit).toHaveLength(0);
    expect(h.executeRefundAction).not.toHaveBeenCalled();
    expect(h.insertAudit).not.toHaveBeenCalled();
  });

  it("crash-window resume: an order_line_edit row already keyed to this idempotency_key is reused, not re-derived or duplicated", async () => {
    seedOrder("shop-1", "order-1", "paid");
    seedLine("shop-1", "order-1", "line-1", "v-1", 5, 1000);
    // Simulate a crashed prior attempt: the edit row committed, but the audit tail never ran (so
    // priorExecutionForKey — mocked to resolve null here — sees nothing).
    store.db.order_line_edit.push({
      id: "edit-crashed",
      shop_id: "shop-1",
      order_id: "order-1",
      order_line_id: "line-1",
      old_quantity: 5,
      new_quantity: 2,
      refund_cents: 3000,
      idempotency_key: "resume-key",
      created_at: new Date().toISOString(),
    });

    const res = await executeReduceLineAction("shop-1", {
      orderId: "order-1",
      orderLineId: "line-1",
      newQuantity: 2,
      restock: false,
      idempotencyKey: "resume-key",
    });

    // No SECOND edit row is inserted; the resumed row's own refund_cents (3000) drives the refund.
    expect(store.db.order_line_edit).toHaveLength(1);
    expect(h.executeRefundAction).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ amountCents: 3000, idempotencyKey: "resume-key:refund" }),
      store.client,
    );
    expect(res.replayed).toBe(false);
  });
});

describe("executeReduceLineAction — concurrent-reduction race", () => {
  it("concurrent_edit: a baseline-index conflict (different key, same line, same old_quantity) surfaces a 409, not a resume or a refund", async () => {
    seedOrder("shop-1", "order-1", "paid");
    seedLine("shop-1", "order-1", "line-1", "v-1", 5, 1000);
    // Arm the race: a DIFFERENT caller's insert lands right before ours, landing on the SAME
    // old_quantity (5) our own read also computed — the exact concurrent-different-key race the
    // baseline unique index (migration 20260710190000) exists to catch.
    store.race.row = {
      shop_id: "shop-1",
      order_id: "order-1",
      order_line_id: "line-1",
      old_quantity: 5,
      new_quantity: 3,
      refund_cents: 2000,
      idempotency_key: "other-caller-key",
    };

    await expect(
      executeReduceLineAction("shop-1", { orderId: "order-1", orderLineId: "line-1", newQuantity: 2, restock: false, idempotencyKey: "k-race" }),
    ).rejects.toMatchObject({ code: "concurrent_edit", status: 409 });

    expect(h.executeRefundAction).not.toHaveBeenCalled();
    // Only the injected "winner" row exists — ours never landed.
    expect(store.db.order_line_edit).toHaveLength(1);
    expect(store.db.order_line_edit[0]).toMatchObject({ idempotency_key: "other-caller-key" });
  });
});

describe("executeReduceLineAction — proportional tax on reductions", () => {
  it("prorates the order's captured tax by this reduction's share of subtotal (10000/800, reduce 2500 subtotal -> 200 tax, refund 2700)", async () => {
    seedOrder("shop-1", "order-1", "paid", { subtotal_cents: 10000, tax_cents: 800 });
    seedLine("shop-1", "order-1", "line-1", "v-1", 5, 1250); // delta of 2 units * 1250 = 2500 subtotal
    h.executeRefundAction.mockResolvedValue({
      auditId: "refund-audit-1",
      outcome: "succeeded",
      refundId: "re_1",
      amountCents: 2700,
      capturedCents: 10800,
      refundedTotalCents: 2700,
      orderState: "partially_refunded",
      restockedLines: 0,
      restockError: null,
      replayed: false,
    });

    const res = await executeReduceLineAction("shop-1", {
      orderId: "order-1",
      orderLineId: "line-1",
      newQuantity: 3,
      restock: false,
      idempotencyKey: "ktax1",
    });

    expect(store.db.order_line_edit[0]).toMatchObject({ old_quantity: 5, new_quantity: 3, refund_cents: 2700 });
    expect(h.executeRefundAction).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ orderId: "order-1", amountCents: 2700, idempotencyKey: "ktax1:refund" }),
      store.client,
    );
    expect(res.refundedCents).toBe(2700);
  });

  it("a zero-tax order refunds the bare unit-price delta only (unchanged behavior)", async () => {
    seedOrder("shop-1", "order-1", "paid", { subtotal_cents: 5000, tax_cents: 0 });
    seedLine("shop-1", "order-1", "line-1", "v-1", 5, 1000);

    await executeReduceLineAction("shop-1", {
      orderId: "order-1",
      orderLineId: "line-1",
      newQuantity: 3,
      restock: false,
      idempotencyKey: "ktax2",
    });

    expect(store.db.order_line_edit[0].refund_cents).toBe(2000);
  });

  it("floors the prorated tax share instead of rounding (10000/799, reduce 2500 subtotal -> 199 tax, refund 2699)", async () => {
    seedOrder("shop-1", "order-1", "paid", { subtotal_cents: 10000, tax_cents: 799 });
    seedLine("shop-1", "order-1", "line-1", "v-1", 5, 1250);

    await executeReduceLineAction("shop-1", {
      orderId: "order-1",
      orderLineId: "line-1",
      newQuantity: 3,
      restock: false,
      idempotencyKey: "ktax3",
    });

    expect(store.db.order_line_edit[0].refund_cents).toBe(2699);
  });

  it("chained edits (5->3 then 3->1) each prorate tax off the SAME order-level subtotal/tax captured at time of sale", async () => {
    seedOrder("shop-1", "order-1", "paid", { subtotal_cents: 5000, tax_cents: 400 });
    seedLine("shop-1", "order-1", "line-1", "v-1", 5, 1000);

    await executeReduceLineAction("shop-1", { orderId: "order-1", orderLineId: "line-1", newQuantity: 3, restock: false, idempotencyKey: "ktax4a" });
    store.db.orders.find((o) => o.id === "order-1")!.state = "partially_refunded";
    await executeReduceLineAction("shop-1", { orderId: "order-1", orderLineId: "line-1", newQuantity: 1, restock: false, idempotencyKey: "ktax4b" });

    // Each reduction: delta 2 * 1000 = 2000 subtotal; tax share floor(400*2000/5000) = 160; refund 2160.
    expect(store.db.order_line_edit[0]).toMatchObject({ old_quantity: 5, new_quantity: 3, refund_cents: 2160 });
    expect(store.db.order_line_edit[1]).toMatchObject({ old_quantity: 3, new_quantity: 1, refund_cents: 2160 });
  });
});

describe("executeEditInvoiceLines", () => {
  function baseOrder(overrides: Record<string, unknown> = {}) {
    seedOrder("shop-1", "order-1", "checkout_pending", { channel: "invoice", buyer_id: null, ...overrides });
  }

  beforeEach(() => {
    h.priceLines.mockResolvedValue({
      lines: [{ variantId: "v-1", quantity: 2, unitPriceCents: 1500, currency: "usd", titleSnapshot: "Widget" }],
      subtotalCents: 3000,
      currency: "usd",
    });
  });

  it("422s an empty or oversized lines array", async () => {
    baseOrder();
    await expect(executeEditInvoiceLines("shop-1", "order-1", [])).rejects.toMatchObject({ code: "invalid_lines", status: 422 });
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ variantId: `v-${i}`, quantity: 1 }));
    await expect(executeEditInvoiceLines("shop-1", "order-1", tooMany)).rejects.toMatchObject({ code: "invalid_lines", status: 422 });
  });

  it("422s a bad quantity", async () => {
    baseOrder();
    await expect(
      executeEditInvoiceLines("shop-1", "order-1", [{ variantId: "v-1", quantity: 0 }]),
    ).rejects.toMatchObject({ code: "invalid_lines", status: 422 });
    await expect(
      executeEditInvoiceLines("shop-1", "order-1", [{ variantId: "v-1", quantity: 1000 }]),
    ).rejects.toMatchObject({ code: "invalid_lines", status: 422 });
  });

  it("404s a missing order", async () => {
    await expect(
      executeEditInvoiceLines("shop-1", "ghost", [{ variantId: "v-1", quantity: 1 }]),
    ).rejects.toMatchObject({ code: "order_not_found", status: 404 });
  });

  it("409s a non-invoice or already-paid order", async () => {
    seedOrder("shop-1", "order-2", "checkout_pending", { channel: "storefront" });
    await expect(
      executeEditInvoiceLines("shop-1", "order-2", [{ variantId: "v-1", quantity: 1 }]),
    ).rejects.toMatchObject({ code: "not_editable_invoice", status: 409 });

    seedOrder("shop-1", "order-3", "paid", { channel: "invoice" });
    await expect(
      executeEditInvoiceLines("shop-1", "order-3", [{ variantId: "v-1", quantity: 1 }]),
    ).rejects.toMatchObject({ code: "not_editable_invoice", status: 409 });
  });

  it("replaces lines wholesale and recomputes totals with 0 shipping/tax when the buyer has no address", async () => {
    baseOrder();
    seedLine("shop-1", "order-1", "old-line", "v-old", 9, 500);

    const res = await executeEditInvoiceLines("shop-1", "order-1", [{ variantId: "v-1", quantity: 2 }]);

    expect(store.db.order_line).toHaveLength(1);
    expect(store.db.order_line[0]).toMatchObject({ variant_id: "v-1", quantity: 2, unit_price_cents: 1500 });
    expect(res).toEqual({ orderId: "order-1", subtotalCents: 3000, shippingCents: 0, taxCents: 0, totalCents: 3000, currency: "usd" });
    expect(h.quoteCart).not.toHaveBeenCalled();

    const orderRow = store.db.orders.find((o) => o.id === "order-1");
    expect(orderRow).toMatchObject({ subtotal_cents: 3000, shipping_cents: 0, tax_cents: 0, total_cents: 3000 });
  });

  it("re-quotes shipping/tax when the buyer has a default shipping address", async () => {
    baseOrder({ buyer_id: "buyer-1" });
    h.loadDefaultShippingAddress.mockResolvedValue({
      name: "Buyer",
      line1: "1 Main St",
      line2: null,
      city: "Springfield",
      region: "IL",
      postal: "62701",
      country: "US",
    });
    h.quoteCart.mockResolvedValue({ shippingCents: 700, taxCents: 240, subtotalCents: 3000, totalCents: 3940 });

    const res = await executeEditInvoiceLines("shop-1", "order-1", [{ variantId: "v-1", quantity: 2 }]);

    expect(h.quoteCart).toHaveBeenCalledWith(
      "shop-1",
      [{ variantId: "v-1", quantity: 2 }],
      expect.objectContaining({ street1: "1 Main St", city: "Springfield", country: "US" }),
      { subtotalCentsOverride: 3000 },
    );
    expect(res).toEqual({ orderId: "order-1", subtotalCents: 3000, shippingCents: 700, taxCents: 240, totalCents: 3940, currency: "usd" });
  });

  it("treats a buyer address with a blank line1 like no address at all: no quoteCart call, 0/0 shipping+tax, no crash", async () => {
    baseOrder({ buyer_id: "buyer-1" });
    h.loadDefaultShippingAddress.mockResolvedValue({
      name: "Buyer",
      line1: "",
      line2: null,
      city: "Springfield",
      region: "IL",
      postal: "62701",
      country: "US",
    });

    const res = await executeEditInvoiceLines("shop-1", "order-1", [{ variantId: "v-1", quantity: 2 }]);

    expect(h.quoteCart).not.toHaveBeenCalled();
    expect(res).toEqual({ orderId: "order-1", subtotalCents: 3000, shippingCents: 0, taxCents: 0, totalCents: 3000, currency: "usd" });
  });

  it("translates a ShipRestrictedError from quoteCart into a typed 422 ship_restricted, not an opaque 500", async () => {
    baseOrder({ buyer_id: "buyer-1" });
    h.loadDefaultShippingAddress.mockResolvedValue({
      name: "Buyer",
      line1: "1 Main St",
      line2: null,
      city: "Springfield",
      region: "IL",
      postal: "62701",
      country: "US",
    });
    h.quoteCart.mockRejectedValue(new ShipRestrictedError("XX", ["v-1"]));

    await expect(
      executeEditInvoiceLines("shop-1", "order-1", [{ variantId: "v-1", quantity: 2 }]),
    ).rejects.toMatchObject({ code: "ship_restricted", status: 422 });
  });
});
