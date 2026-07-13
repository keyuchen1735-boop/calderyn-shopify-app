import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for the `orders` table update executeCancelAction performs directly
// (cancelled_at/cancel_reason stamp). Mirrors the Builder pattern in checkout.server.test.ts /
// order.server.test.ts.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { orders: [], action_audit: [] };

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
  expireInvoiceSession: vi.fn(),
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
vi.mock("./invoice.server", () => ({ expireInvoiceSession: h.expireInvoiceSession }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { executeCancelAction } from "./cancel.server";

function seedOrder(
  shopId: string,
  id: string,
  state: string,
  cancelledAt: string | null = null,
  extra: Record<string, unknown> = {},
) {
  store.db.orders.push({ id, shop_id: shopId, state, cancelled_at: cancelledAt, ...extra });
}
function seedAudit(
  shopId: string,
  id: string,
  actionKind: string,
  params: Record<string, unknown>,
  outcome: string = "succeeded",
) {
  store.db.action_audit.push({ id, shop_id: shopId, action_kind: actionKind, outcome, params });
}

beforeEach(() => {
  store.db.orders.length = 0;
  store.db.action_audit.length = 0;
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
  h.expireInvoiceSession.mockResolvedValue(undefined);
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
    expect(audit.params.order_id).toBe("order-1b");
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
    const audit = h.insertAudit.mock.calls[0][2];
    expect(audit.params.order_id).toBe("order-2");
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
    const audit = h.insertAudit.mock.calls[0][2];
    expect(audit.params.order_id).toBe("order-3");
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
    seedAudit("shop-1", "raudit-9", "issue_refund", { order_id: "order-9" });
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
    expect(audit.params.order_id).toBe("order-9");
    expect(h.sendCancellationNotice).not.toHaveBeenCalled();
  });

  it("crash-resume hardening: a '<key>:refund' hit whose audited order_id belongs to a DIFFERENT order does not resume, still 409s", async () => {
    // Simulates an idempotency-key collision: the outer key "k11" happens to share its
    // ":refund" suffix with a completed refund audit row that actually belongs to some
    // OTHER order ("order-other"), not the order being cancelled here ("order-11"). Without
    // the params.order_id / action_kind check, this would incorrectly resume order-11 onto
    // order-other's refund.
    seedOrder("shop-1", "order-11", "refunded");
    seedAudit("shop-1", "raudit-11", "issue_refund", { order_id: "order-other" });
    h.prior.mockImplementation(async (_shopId: string, key: string) => {
      if (key === "k11:refund") return { id: "raudit-11", outcome: "succeeded" };
      return null;
    });

    await expect(
      executeCancelAction("shop-1", {
        orderId: "order-11",
        refund: true,
        restock: false,
        idempotencyKey: "k11",
      }),
    ).rejects.toMatchObject({ code: "order_not_cancellable", status: 409 });
    expect(h.executeRefundAction).not.toHaveBeenCalled();
    expect(h.insertAudit).not.toHaveBeenCalled();
    expect(store.db.orders[0].cancelled_at).toBeNull();
  });

  it("crash-resume hardening: a '<key>:refund' hit whose audited action_kind is NOT issue_refund does not resume, still 409s", async () => {
    // A key collision against some unrelated action (not a refund at all) that happens to
    // match this order's id in its params must not be treated as proof a refund ran.
    seedOrder("shop-1", "order-12", "refunded");
    seedAudit("shop-1", "raudit-12", "fulfill_order", { order_id: "order-12" });
    h.prior.mockImplementation(async (_shopId: string, key: string) => {
      if (key === "k12:refund") return { id: "raudit-12", outcome: "succeeded" };
      return null;
    });

    await expect(
      executeCancelAction("shop-1", {
        orderId: "order-12",
        refund: true,
        restock: false,
        idempotencyKey: "k12",
      }),
    ).rejects.toMatchObject({ code: "order_not_cancellable", status: 409 });
    expect(h.executeRefundAction).not.toHaveBeenCalled();
    expect(h.insertAudit).not.toHaveBeenCalled();
  });

  it("crash-resume hardening: a '<key>:refund' hit whose audited outcome is NOT 'succeeded' does not resume, still 409s", async () => {
    // Defense-in-depth: refund.server.ts today only ever writes issue_refund audits with the
    // literal outcome "succeeded" (a Stripe failure throws before any audit insert), so this path
    // isn't reachable through the real executor — but the gate should not trust a match on
    // action_kind + order_id alone if that invariant ever loosens.
    seedOrder("shop-1", "order-13", "refunded");
    seedAudit("shop-1", "raudit-13", "issue_refund", { order_id: "order-13" }, "retrying");
    h.prior.mockImplementation(async (_shopId: string, key: string) => {
      if (key === "k13:refund") return { id: "raudit-13", outcome: "retrying" };
      return null;
    });

    await expect(
      executeCancelAction("shop-1", {
        orderId: "order-13",
        refund: true,
        restock: false,
        idempotencyKey: "k13",
      }),
    ).rejects.toMatchObject({ code: "order_not_cancellable", status: 409 });
    expect(h.executeRefundAction).not.toHaveBeenCalled();
    expect(h.insertAudit).not.toHaveBeenCalled();
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

  it("fix C2: cancelling an invoice-channel order expires its hosted pay-link session", async () => {
    seedOrder("shop-1", "order-inv1", "checkout_pending", null, { channel: "invoice" });

    await executeCancelAction("shop-1", { orderId: "order-inv1", refund: false, restock: false, idempotencyKey: "kinv1" });

    expect(h.expireInvoiceSession).toHaveBeenCalledWith("shop-1", "order-inv1");
  });

  it("fix C2: does NOT touch any hosted session for a non-invoice order", async () => {
    seedOrder("shop-1", "order-1", "checkout_pending");

    await executeCancelAction("shop-1", { orderId: "order-1", refund: false, restock: false, idempotencyKey: "knoninv" });

    expect(h.expireInvoiceSession).not.toHaveBeenCalled();
  });

  it("fix C2: a session-expiry failure is logged loudly but does not fail an otherwise-successful cancel", async () => {
    seedOrder("shop-1", "order-inv2", "paid", null, { channel: "invoice" });
    h.expireInvoiceSession.mockRejectedValueOnce(new Error("stripe down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await executeCancelAction("shop-1", { orderId: "order-inv2", refund: false, restock: false, idempotencyKey: "kinv2" });

    expect(res.orderState).toBe("cancelled");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/could not expire the invoice's hosted pay-link session/), expect.any(Error));
    errorSpy.mockRestore();
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
