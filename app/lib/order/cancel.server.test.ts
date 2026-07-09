import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for the `orders` table update executeCancelAction performs directly
// (cancelled_at/cancel_reason stamp). Mirrors the Builder pattern in checkout.server.test.ts /
// order.server.test.ts.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { orders: [] };

  class Builder {
    private op: "select" | "update" = "select";
    private vals: Row = {};
    private filters: Array<[string, unknown]> = [];
    private wantSingle = false;
    private readonly table: string;

    constructor(table: string) {
      this.table = table;
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
    private run(): { data: unknown; error: unknown } {
      const t = db[this.table];
      const matched = t.filter((r) => this.filters.every(([c, v]) => r[c] === v));
      if (this.op === "update") {
        for (const r of matched) Object.assign(r, this.vals);
        return this.wrap(matched);
      }
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
  restockOrderLines: vi.fn(),
  releaseReservation: vi.fn(),
  executeRefundAction: vi.fn(),
  sendCancellationNotice: vi.fn(),
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
vi.mock("../inventory/engine.server", () => ({
  restockOrderLines: h.restockOrderLines,
  releaseReservation: h.releaseReservation,
}));
vi.mock("../actions/refund.server", () => ({ executeRefundAction: h.executeRefundAction }));
vi.mock("./notify-email.server", () => ({ sendCancellationNotice: h.sendCancellationNotice }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { executeCancelAction } from "./cancel.server";

function seedOrder(shopId: string, id: string, state: string, cancelledAt: string | null = null) {
  store.db.orders.push({ id, shop_id: shopId, state, cancelled_at: cancelledAt });
}

beforeEach(() => {
  store.db.orders.length = 0;
  vi.clearAllMocks();
  h.prior.mockResolvedValue(null);
  h.insertAudit.mockResolvedValue({ id: "audit-1", outcome: "succeeded" });
  h.transitionOrder.mockResolvedValue({ id: "t-1" });
  h.restockOrderLines.mockResolvedValue({ restockedLines: 0, failedVariantIds: [] });
  h.releaseReservation.mockResolvedValue(undefined);
  h.executeRefundAction.mockResolvedValue({
    auditId: "raudit-1",
    outcome: "succeeded",
    refundId: "re_1",
    amountCents: 2500,
    capturedCents: 2500,
    refundedTotalCents: 2500,
    orderState: "refunded",
    restockedLines: 0,
    restockError: null,
    replayed: false,
  });
  h.sendCancellationNotice.mockResolvedValue({ sent: true, id: "email-1" });
});

describe("executeCancelAction", () => {
  it("checkout_pending: releases the reservation and transitions to cancelled", async () => {
    seedOrder("shop-1", "order-1", "checkout_pending");

    const res = await executeCancelAction("shop-1", {
      orderId: "order-1",
      refund: false,
      restock: false,
      idempotencyKey: "k1",
    });

    expect(h.releaseReservation).toHaveBeenCalledWith("shop-1", "order-1");
    expect(h.transitionOrder).toHaveBeenCalledWith("shop-1", "order-1", "cancelled", expect.any(String));
    expect(h.executeRefundAction).not.toHaveBeenCalled();
    expect(res.orderState).toBe("cancelled");
    expect(res.refunded).toBe(false);
    expect(store.db.orders[0].cancelled_at).toBeTruthy();
    expect(store.db.orders[0].cancel_reason).toBeNull();
  });

  it("checkout_pending + refund requested: refund flag is ignored (nothing captured), recorded as refund_skipped", async () => {
    seedOrder("shop-1", "order-1b", "checkout_pending");

    const res = await executeCancelAction("shop-1", {
      orderId: "order-1b",
      refund: true,
      restock: false,
      idempotencyKey: "k1b",
    });

    expect(h.executeRefundAction).not.toHaveBeenCalled();
    expect(res.refunded).toBe(false);
    const audit = h.insertAudit.mock.calls[0][2];
    expect(audit.params.refund_skipped).toBe("not_captured");
  });

  it("paid + refund: delegates to executeRefundAction with the ':refund' idempotency suffix and restock passthrough, and does NOT call transitionOrder", async () => {
    seedOrder("shop-1", "order-2", "paid");

    const res = await executeCancelAction("shop-1", {
      orderId: "order-2",
      reason: "buyer changed mind",
      refund: true,
      restock: true,
      idempotencyKey: "k2",
    });

    expect(h.executeRefundAction).toHaveBeenCalledWith(
      "shop-1",
      {
        orderId: "order-2",
        idempotencyKey: "k2:refund",
        actor: undefined,
        reason: "buyer changed mind",
        restock: true,
      },
      store.client,
    );
    expect(h.transitionOrder).not.toHaveBeenCalled();
    expect(res.orderState).toBe("refunded");
    expect(res.refunded).toBe(true);
    expect(res.restockedLines).toBe(0);
    expect(store.db.orders[0].cancelled_at).toBeTruthy();
    expect(store.db.orders[0].cancel_reason).toBe("buyer changed mind");
    expect(h.sendCancellationNotice).toHaveBeenCalledWith("shop-1", "order-2", { refunded: true });
  });

  it("paid without refund: transitions to cancelled and restocks when asked", async () => {
    seedOrder("shop-1", "order-3", "partially_fulfilled");
    h.restockOrderLines.mockResolvedValueOnce({ restockedLines: 3, failedVariantIds: [] });

    const res = await executeCancelAction("shop-1", {
      orderId: "order-3",
      refund: false,
      restock: true,
      idempotencyKey: "k3",
    });

    expect(h.transitionOrder).toHaveBeenCalledWith("shop-1", "order-3", "cancelled", expect.any(String));
    expect(h.restockOrderLines).toHaveBeenCalledWith("shop-1", "order-3", "cancel");
    expect(h.executeRefundAction).not.toHaveBeenCalled();
    expect(res.orderState).toBe("cancelled");
    expect(res.refunded).toBe(false);
    expect(res.restockedLines).toBe(3);
    expect(h.sendCancellationNotice).toHaveBeenCalledWith("shop-1", "order-3", { refunded: false });
  });

  it("paid without refund and restock:false never calls restockOrderLines", async () => {
    seedOrder("shop-1", "order-3b", "paid");
    await executeCancelAction("shop-1", { orderId: "order-3b", refund: false, restock: false, idempotencyKey: "k3b" });
    expect(h.restockOrderLines).not.toHaveBeenCalled();
  });

  it("already-cancelled (state) is refused with a 409", async () => {
    seedOrder("shop-1", "order-4", "cancelled");
    await expect(
      executeCancelAction("shop-1", { orderId: "order-4", refund: false, restock: false, idempotencyKey: "k4" }),
    ).rejects.toMatchObject({ code: "already_cancelled", status: 409 });
  });

  it("already-cancelled (cancelled_at stamped) is refused with a 409 even if state lags", async () => {
    seedOrder("shop-1", "order-4b", "paid", "2026-07-01T00:00:00.000Z");
    await expect(
      executeCancelAction("shop-1", { orderId: "order-4b", refund: false, restock: false, idempotencyKey: "k4b" }),
    ).rejects.toMatchObject({ code: "already_cancelled", status: 409 });
  });

  it("a fulfilled order is not cancellable (409 order_not_cancellable)", async () => {
    seedOrder("shop-1", "order-5", "fulfilled");
    await expect(
      executeCancelAction("shop-1", { orderId: "order-5", refund: false, restock: false, idempotencyKey: "k5" }),
    ).rejects.toMatchObject({ code: "order_not_cancellable", status: 409 });
  });

  it("404s a missing order", async () => {
    await expect(
      executeCancelAction("shop-1", { orderId: "ghost", refund: false, restock: false, idempotencyKey: "k6" }),
    ).rejects.toMatchObject({ code: "order_not_found", status: 404 });
  });

  it("crash-resume: a completed '<key>:refund' execution resumes the stamp/audit instead of a misleading 409", async () => {
    // Simulates a prior call that ran the refund branch (money moved, order -> refunded) and
    // crashed before the cancelled_at stamp / outer audit row landed. cancelled_at is still null.
    seedOrder("shop-1", "order-9", "refunded");
    h.prior.mockImplementation(async (_shopId: string, key: string) => {
      if (key === "k9:refund") return { id: "raudit-9", outcome: "succeeded" };
      return null;
    });

    const res = await executeCancelAction("shop-1", {
      orderId: "order-9",
      reason: "buyer changed mind",
      refund: true,
      restock: false,
      idempotencyKey: "k9",
    });

    expect(h.executeRefundAction).not.toHaveBeenCalled();
    expect(res.replayed).toBe(false);
    expect(res.orderState).toBe("refunded");
    expect(res.refunded).toBe(true);
    expect(store.db.orders[0].cancelled_at).toBeTruthy();
    expect(store.db.orders[0].cancel_reason).toBe("buyer changed mind");
    expect(h.insertAudit).toHaveBeenCalledTimes(1);
    const audit = h.insertAudit.mock.calls[0][2];
    expect(audit.params.resumed_after_refund_crash).toBe(true);
    expect(h.sendCancellationNotice).not.toHaveBeenCalled();
  });

  it("state refunded with NO prior '<key>:refund' execution is still refused with 409 order_not_cancellable", async () => {
    seedOrder("shop-1", "order-10", "refunded");
    h.prior.mockResolvedValue(null);

    await expect(
      executeCancelAction("shop-1", {
        orderId: "order-10",
        refund: true,
        restock: false,
        idempotencyKey: "k10",
      }),
    ).rejects.toMatchObject({ code: "order_not_cancellable", status: 409 });
    expect(h.executeRefundAction).not.toHaveBeenCalled();
    expect(h.insertAudit).not.toHaveBeenCalled();
  });

  it("replay: returns replayed:true without acting again", async () => {
    h.prior.mockResolvedValue({ id: "audit-9", outcome: "succeeded" });
    seedOrder("shop-1", "order-7", "refunded");

    const res = await executeCancelAction("shop-1", { orderId: "order-7", refund: true, restock: true, idempotencyKey: "dup" });

    expect(res).toEqual({ auditId: "audit-9", orderState: "refunded", refunded: true, restockedLines: 0, replayed: true });
    expect(h.transitionOrder).not.toHaveBeenCalled();
    expect(h.executeRefundAction).not.toHaveBeenCalled();
    expect(h.insertAudit).not.toHaveBeenCalled();
  });
});
